/* eslint-disable no-new */
/* global afterEach, describe, it, expect, jest */
const Cache = require('../lib/cache')

describe('Cache', () => {
  it('should throw when account is not defined', () => {
    expect(() => {
      const config = { repository: 'hyper' }
      new Cache(config)
    }).toThrow(/ACCOUNT/)
  })

  it('should throw when repository is not defined', () => {
    expect(() => {
      const config = { account: 'zeit' }
      new Cache(config)
    }).toThrow(/REPOSITORY/)
  })

  it('should warn when token is defined and url is not', () => {
    const originalWarn = console.warn
    let warnCalled = false
    console.warn = () => {
      warnCalled = true
    }
    const config = { account: 'zeit', repository: 'hyper', token: 'abc' }
    new Cache(config)
    console.warn = originalWarn
    expect(warnCalled).toBe(true)
  })

  it('should run without errors', () => {
    const config = {
      account: 'zeit',
      repository: 'hyper',
      token: process.env.TOKEN,
      url: process.env.URL
    }

    new Cache(config)
  })

  it('should refresh the cache', async () => {
    const config = {
      account: 'zeit',
      repository: 'hyper',
      token: process.env.TOKEN,
      url: process.env.URL
    }

    const cache = new Cache(config)
    const storage = await cache.loadCache()

    expect(typeof storage.version).toBe('string')
    expect(typeof storage.platforms).toBe('object')
  })

  it('should set platforms correctly', async () => {
    const config = {
      account: 'zeit',
      repository: 'hyper',
      token: process.env.TOKEN,
      url: process.env.URL
    }

    const cache = new Cache(config)
    const storage = await cache.loadCache()

    console.log(storage.platforms.darwin)
  })
})

describe('stream-aware Cache', () => {
  const loadMockedCache = pages => {
    jest.resetModules()

    const fetch = jest.fn(async url => {
      const page = Number(new URL(url).searchParams.get('page'))

      return {
        status: 200,
        json: async () => pages[page - 1] || []
      }
    })

    jest.doMock('node-fetch', () => fetch)

    return {
      Cache: require('../lib/cache'),
      fetch
    }
  }

  const release = (tagName, publishedAt) => ({
    tag_name: tagName,
    body: `${tagName} notes`,
    published_at: publishedAt,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: `Hazel-${tagName}-mac.zip`,
        browser_download_url: `https://example.com/${tagName}/mac.zip`,
        url: `https://api.example.com/${tagName}/mac.zip`,
        content_type: 'application/zip',
        size: 12000000
      },
      {
        name: `Hazel-${tagName}.exe`,
        browser_download_url: `https://example.com/${tagName}/setup.exe`,
        url: `https://api.example.com/${tagName}/setup.exe`,
        content_type: 'application/octet-stream',
        size: 18000000
      }
    ]
  })

  afterEach(() => {
    jest.dontMock('node-fetch')
  })

  it('returns the latest cached release per stream', async () => {
    const page = [
      release('2.0.0', '2024-03-01T00:00:00Z'),
      release('2.0.0-uat', '2024-03-02T00:00:00Z'),
      release('1.9.0-uat', '2024-02-01T00:00:00Z')
    ]
    const { Cache } = loadMockedCache([page])
    const cache = new Cache({ account: 'zeit', repository: 'hyper' })

    const production = await cache.loadCache()
    const uat = await cache.loadCacheForStream('uat')

    expect(production.version).toBe('2.0.0')
    expect(production.notes).toBe('2.0.0 notes')
    expect(production.pub_date).toBe('2024-03-01T00:00:00Z')
    expect(production.platforms.darwin.name).toBe('Hazel-2.0.0-mac.zip')
    expect(production.assets['Hazel-2.0.0.exe'].size).toBe(18)

    expect(uat.version).toBe('2.0.0-uat')
    expect(uat.notes).toBe('2.0.0-uat notes')
    expect(uat.pub_date).toBe('2024-03-02T00:00:00Z')
    expect(uat.platforms.darwin.name).toBe('Hazel-2.0.0-uat-mac.zip')
  })

  it('returns production from loadCache', async () => {
    const { Cache } = loadMockedCache([
      [release('3.0.0', '2024-04-01T00:00:00Z')]
    ])
    const cache = new Cache({ account: 'zeit', repository: 'hyper' })

    await expect(cache.loadCache()).resolves.toMatchObject({
      version: '3.0.0'
    })
  })

  it('returns UAT from loadCacheForStream', async () => {
    const { Cache } = loadMockedCache([
      [release('3.0.0-uat', '2024-04-01T00:00:00Z')]
    ])
    const cache = new Cache({ account: 'zeit', repository: 'hyper' })

    await expect(cache.loadCacheForStream('uat')).resolves.toMatchObject({
      version: '3.0.0-uat'
    })
  })

  it('returns an empty cache for unknown streams', async () => {
    const { Cache } = loadMockedCache([
      [release('3.0.0', '2024-04-01T00:00:00Z')]
    ])
    const cache = new Cache({ account: 'zeit', repository: 'hyper' })

    await expect(cache.loadCacheForStream('unknown')).resolves.toEqual({})
  })

  it('clears stale cache data when GitHub returns an empty release page', async () => {
    const { Cache } = loadMockedCache([[]])
    const cache = new Cache({ account: 'zeit', repository: 'hyper' })

    cache.latest = { version: 'stale' }
    cache.latestByStream = {
      production: { version: 'stale' }
    }

    const production = await cache.loadCache()

    expect(production).toEqual({})
    expect(cache.latest).toEqual({})
    expect(cache.latestByStream).toEqual({})
    expect(typeof cache.lastUpdate).toBe('number')
  })

  it('caches streams found on later GitHub release pages', async () => {
    const firstPage = Array.from({ length: 100 }, (value, index) => {
      return release(`3.0.${index}`, '2024-04-01T00:00:00Z')
    })
    const { Cache, fetch } = loadMockedCache([
      firstPage,
      [release('4.0.0-uat', '2024-05-01T00:00:00Z')]
    ])
    const cache = new Cache({ account: 'zeit', repository: 'hyper' })

    const uat = await cache.loadCacheForStream('uat')

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(uat.version).toBe('4.0.0-uat')
  })
})
