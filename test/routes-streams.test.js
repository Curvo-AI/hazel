/* global describe, it, expect */
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
})
