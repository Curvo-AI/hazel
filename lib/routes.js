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
  const DEFAULT_STREAM = 'production'

  const normaliseStream = stream => {
    if (!stream || typeof stream !== 'string') {
      return DEFAULT_STREAM
    }

    const value = stream.toLowerCase()
    return value === 'production' ? DEFAULT_STREAM : value
  }

  const selectStreamRelease = (latest, streamName) => {
    const desiredStream = normaliseStream(streamName)
    const fromStreams = latest.streams && latest.streams[desiredStream]

    if (fromStreams) {
      return { release: fromStreams, stream: desiredStream }
    }

    if (!streamName && latest && latest.version) {
      return { release: latest, stream: DEFAULT_STREAM }
    }

    return { release: null, stream: desiredStream }
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

  const resolvePlatform = (platformName, isUpdate) => {
    if (platformName === 'mac' && !isUpdate) {
      return 'dmg'
    }

    if (platformName === 'mac_arm64' && !isUpdate) {
      return 'dmg_arm64'
    }

    return checkAlias(platformName)
  }

  const handleDownload = async (req, res, streamParam, platformParam) => {
    const params = urlHelpers.parse(req.url, true).query
    const isUpdate = params && params.update
    const latest = await loadCache()
    const { release } = selectStreamRelease(latest, streamParam)

    if (!release) {
      send(res, 404, 'No release available for this stream')
      return
    }

    let platform = platformParam

    if (!platform) {
      const userAgent = parse(req.headers['user-agent'])

      if (userAgent.isMac && isUpdate) {
        platform = 'darwin'
      } else if (userAgent.isMac && !isUpdate) {
        platform = 'dmg'
      } else if (userAgent.isWindows) {
        platform = 'exe'
      }
    }

    platform = resolvePlatform(platform, isUpdate)

    if (!platform) {
      send(res, 500, 'The specified platform is not valid')
      return
    }

    if (!release.platforms || !release.platforms[platform]) {
      send(res, 404, 'No download available for your platform!')
      return
    }

    if (shouldProxyPrivateDownload) {
      proxyPrivateDownload(release.platforms[platform], req, res)
      return
    }

    res.writeHead(302, {
      Location: release.platforms[platform].url
    })

    res.end()
  }

  exports.download = (req, res) => handleDownload(req, res)
  exports.downloadStream = (req, res) =>
    handleDownload(req, res, req.params.stream)
  exports.downloadPlatform = (req, res) =>
    handleDownload(req, res, undefined, req.params.platform)
  exports.downloadPlatformStream = (req, res) =>
    handleDownload(req, res, req.params.stream, req.params.platform)

  const handleDownloadFile = async (req, res, streamParam) => {
    const { filename } = req.params
    const latest = await loadCache()
    const { release } = selectStreamRelease(latest, streamParam)

    if (!release || !release.version) {
      send(res, 404, 'No release available')
      return
    }

    const asset = release.assets && release.assets[filename]

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

  exports.downloadFile = (req, res) => handleDownloadFile(req, res)
  exports.downloadFileStream = (req, res) =>
    handleDownloadFile(req, res, req.params.stream)

  const handleUpdate = async (req, res, streamParam) => {
    const { platform: platformName, version } = req.params
    const clientVersion = valid(version)

    if (!clientVersion) {
      send(res, 500, {
        error: 'version_invalid',
        message: 'The specified version is not SemVer-compatible'
      })

      return
    }

    const platform = resolvePlatform(platformName, true)

    if (!platform) {
      send(res, 500, {
        error: 'invalid_platform',
        message: 'The specified platform is not valid'
      })

      return
    }

    const latest = await loadCache()
    const { release, stream } = selectStreamRelease(latest, streamParam)

    if (!release || !release.platforms || !release.platforms[platform]) {
      res.statusCode = 204
      res.end()

      return
    }

    const releaseVersion = release.baseVersion || release.version

    if (!valid(releaseVersion)) {
      res.statusCode = 204
      res.end()
      return
    }

    if (compare(releaseVersion, clientVersion) !== 0) {
      const { notes, pub_date } = release
      const downloadPath =
        stream === DEFAULT_STREAM
          ? `/download/${platformName}?update=true`
          : `/download/${stream}/${platformName}?update=true`

      send(res, 200, {
        name: release.version,
        notes,
        pub_date,
        url: shouldProxyPrivateDownload
          ? `${getBaseUrl(req)}${downloadPath}`
          : release.platforms[platform].url
      })

      return
    }

    res.statusCode = 204
    res.end()
  }

  exports.update = (req, res) => handleUpdate(req, res)
  exports.updateStream = (req, res) => handleUpdate(req, res, req.params.stream)

  const handleReleases = async (req, res, streamParam) => {
    const latest = await loadCache()
    const { release, stream } = selectStreamRelease(latest, streamParam)

    if (!release || !release.files || !release.files.RELEASES) {
      res.statusCode = 204
      res.end()

      return
    }

    let content = release.files.RELEASES

    if (shouldProxyPrivateDownload) {
      const baseUrl = getBaseUrl(req)
      content = content.replace(/([^\s]+\.nupkg)/gi, match => {
        const path =
          stream === DEFAULT_STREAM
            ? `/download/file/${match}`
            : `/download/file/${stream}/${match}`
        return `${baseUrl}${path}`
      })
    } else {
      const matches = content.match(/([^\s]+\.nupkg)/gi)
      if (matches) {
        for (const filename of matches) {
          const downloadUrl = `https://github.com/${config.account}/${
            config.repository
          }/releases/download/${release.version}/${filename}`
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

  exports.releases = (req, res) => handleReleases(req, res)
  exports.releasesStream = (req, res) =>
    handleReleases(req, res, req.params.stream)

  exports.overview = async (req, res) => {
    const latest = await loadCache()

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
