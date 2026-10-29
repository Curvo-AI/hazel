/* global afterEach, describe, it, expect, jest */
const http = require('http')
const hazel = require('../lib')

const initialEnv = Object.assign({}, process.env)
const realFetch = global.fetch

afterEach(() => {
  process.env = initialEnv
  global.fetch = realFetch
})

const listen = handler => {
  const server = http.createServer(handler)

  return new Promise(resolve => {
    server.listen(0, () => resolve(server))
  })
}

describe('Server', () => {
  it('Should start without errors', async () => {
    process.env = {
      ACCOUNT: 'zeit',
      REPOSITORY: 'hyper'
    }

    const run = require('../lib/server')
    const server = await listen(run)

    server.close()
  })

  it('responds with 503 instead of hanging when GitHub is unavailable', async () => {
    global.fetch = jest.fn(async () => ({ status: 503 }))

    const server = await listen(hazel({ account: 'zeit', repository: 'hyper' }))
    const { port } = server.address()

    try {
      const res = await realFetch(
        `http://localhost:${port}/update/darwin/1.0.0`,
        { signal: AbortSignal.timeout(10000) }
      )

      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ error: 'cache_unavailable' })
    } finally {
      server.close()
    }
  })
})
