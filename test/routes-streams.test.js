/* global afterEach, describe, it, expect, jest */
const createRoutes = require('../lib/routes')

const createResponse = () => {
  const res = {
    body: null,
    headers: {},
    statusCode: null,
    end(body) {
      this.body = body
    },
    getHeader(name) {
      return this.headers[name]
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = Object.assign({}, this.headers, headers)
    }
  }

  return res
}

const parseBody = res => JSON.parse(res.body)

const createCache = streams => {
  const calls = []

  return {
    calls,
    async loadCache() {
      calls.push('loadCache')
      return streams.production
    },
    async loadCacheForStream(stream) {
      calls.push(stream)
      return streams[stream] || {}
    }
  }
}

const createLatest = (version, url) => ({
  version,
  notes: `Notes for ${version}`,
  pub_date: '2026-04-28T00:00:00.000Z',
  platforms: {
    darwin: {
      url
    }
  }
})

const createRoutesForCache = (cache, config) => {
  return createRoutes({
    cache,
    config: Object.assign(
      {
        account: 'curvo',
        repository: 'hazel'
      },
      config
    )
  })
}

describe('Stream-aware routes', () => {
  it('uses the stream inferred from the client version for updates', async () => {
    const cache = createCache({
      production: createLatest('1.0.1', 'https://example.com/prod.zip'),
      uat: createLatest('1.0.1-uat', 'https://example.com/uat.zip')
    })
    const routes = createRoutesForCache(cache)
    const req = {
      headers: {},
      params: {
        platform: 'darwin',
        version: '1.0.0-uat'
      },
      url: '/update/darwin/1.0.0-uat'
    }
    const res = createResponse()

    await routes.update(req, res)

    expect(cache.calls).toEqual(['uat'])
    expect(res.statusCode).toBe(200)
    expect(parseBody(res)).toMatchObject({
      name: '1.0.1-uat',
      url: 'https://example.com/uat.zip'
    })
  })

  it('lets the query stream override the version stream for updates', async () => {
    const cache = createCache({
      production: createLatest('1.0.1', 'https://example.com/prod.zip'),
      uat: createLatest('1.0.1-uat', 'https://example.com/uat.zip')
    })
    const routes = createRoutesForCache(cache)
    const req = {
      headers: {},
      params: {
        platform: 'darwin',
        version: '1.0.0-uat'
      },
      url: '/update/darwin/1.0.0-uat?stream=production'
    }
    const res = createResponse()

    await routes.update(req, res)

    expect(cache.calls).toEqual(['production'])
    expect(parseBody(res)).toMatchObject({
      name: '1.0.1',
      url: 'https://example.com/prod.zip'
    })
  })

  it('rejects invalid query streams before loading the cache', async () => {
    const cache = createCache({
      production: createLatest('1.0.1', 'https://example.com/prod.zip')
    })
    const routes = createRoutesForCache(cache)
    const req = {
      headers: {},
      params: {
        platform: 'darwin',
        version: '1.0.0'
      },
      url: '/update/darwin/1.0.0?stream=uat.beta'
    }
    const res = createResponse()

    await routes.update(req, res)

    expect(cache.calls).toEqual([])
    expect(res.statusCode).toBe(400)
    expect(parseBody(res)).toMatchObject({
      error: 'stream_invalid'
    })
  })

  it('keeps the inferred stream in private RELEASES package URLs', async () => {
    const cache = createCache({
      production: {},
      uat: {
        version: '1.0.1-uat',
        files: {
          RELEASES: 'abc app-1.0.1-uat-full.nupkg 123'
        }
      }
    })
    const routes = createRoutesForCache(cache, {
      token: 'secret',
      url: 'https://updates.example.com'
    })
    const req = {
      headers: {},
      params: {
        version: '1.0.0-uat'
      },
      url: '/update/win32/1.0.0-uat/RELEASES'
    }
    const res = createResponse()

    await routes.releases(req, res)

    expect(cache.calls).toEqual(['uat'])
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(
      'https://updates.example.com/download/file/app-1.0.1-uat-full.nupkg?stream=uat'
    )
  })

  it('keeps production update URLs unchanged when no stream is selected', async () => {
    const cache = createCache({
      production: createLatest('1.0.1', 'https://example.com/prod.zip')
    })
    const routes = createRoutesForCache(cache, {
      token: 'secret',
      url: 'https://updates.example.com'
    })
    const req = {
      headers: {},
      params: {
        platform: 'darwin',
        version: '1.0.0'
      },
      url: '/update/darwin/1.0.0'
    }
    const res = createResponse()

    await routes.update(req, res)

    expect(cache.calls).toEqual(['production'])
    expect(parseBody(res)).toMatchObject({
      url: 'https://updates.example.com/download/darwin?update=true'
    })
  })

  it('does not update unsuffixed clients for production-suffixed tags', async () => {
    const cache = createCache({
      production: createLatest(
        '1.0.0-production',
        'https://example.com/prod.zip'
      )
    })
    const routes = createRoutesForCache(cache)
    const req = {
      headers: {},
      params: {
        platform: 'darwin',
        version: '1.0.0'
      },
      url: '/update/darwin/1.0.0'
    }
    const res = createResponse()

    await routes.update(req, res)

    expect(cache.calls).toEqual(['production'])
    expect(res.statusCode).toBe(204)
  })

  it('does not update unsuffixed clients for virtual-stream tags', async () => {
    const cache = createCache({
      production: createLatest('1.2.4', 'https://example.com/prod.zip'),
      'sv-cc': createLatest('v1.2.4-sv-cc', 'https://example.com/sv-cc.zip')
    })
    const routes = createRoutesForCache(cache)
    const req = {
      headers: {},
      params: {
        platform: 'darwin',
        version: '1.2.4'
      },
      url: '/update/darwin/1.2.4?stream=sv-cc'
    }
    const res = createResponse()

    await routes.update(req, res)

    expect(cache.calls).toEqual(['sv-cc'])
    expect(res.statusCode).toBe(204)
  })
  describe('private downloads', () => {
    const realFetch = global.fetch

    afterEach(() => {
      global.fetch = realFetch
    })

    const privateLatest = {
      version: '1.0.1',
      platforms: {
        darwin: {
          api_url: 'https://api.github.com/repos/curvo/hazel/releases/assets/1',
          url: 'https://github.com/curvo/hazel/releases/download/1.0.1/a.zip'
        }
      }
    }

    const downloadDarwin = async fetchResponse => {
      global.fetch = jest.fn(async () => fetchResponse)
      const routes = createRoutesForCache(
        createCache({ production: privateLatest }),
        { token: 'secret' }
      )
      const req = {
        headers: {},
        params: { platform: 'darwin' },
        url: '/download/darwin?update=true'
      }
      const res = createResponse()

      await routes.downloadPlatform(req, res)

      return res
    }

    it('sends the token as a header, not in the URL', async () => {
      const res = await downloadDarwin({
        status: 302,
        headers: new Headers({ Location: 'https://objects.example.com/a.zip' })
      })

      const [url, options] = global.fetch.mock.calls[0]

      expect(url).toBe(privateLatest.platforms.darwin.api_url)
      expect(url).not.toContain('secret')
      expect(options.headers.Authorization).toBe('token secret')
      expect(res.statusCode).toBe(302)
      expect(res.headers.Location).toBe('https://objects.example.com/a.zip')
    })

    it('responds with 502 when GitHub does not redirect to the asset', async () => {
      const res = await downloadDarwin({ status: 404, headers: new Headers() })

      expect(res.statusCode).toBe(502)
    })

    it('responds with 502 when the GitHub request fails', async () => {
      global.fetch = jest.fn(async () => {
        throw new Error('network down')
      })
      const routes = createRoutesForCache(
        createCache({ production: privateLatest }),
        { token: 'secret' }
      )
      const res = createResponse()

      await routes.downloadPlatform(
        {
          headers: {},
          params: { platform: 'darwin' },
          url: '/download/darwin?update=true'
        },
        res
      )

      expect(res.statusCode).toBe(502)
    })
  })
})
