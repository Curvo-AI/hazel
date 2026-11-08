// Fake GitHub (HTTPS on 443) and fake SSM (HTTP on 8082), controlled over
// HTTP on 8081. Hazel reaches it through --add-host DNS overrides.
const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')

const certs = path.join(__dirname, 'certs')
const defaults = () => ({
  pages: [],
  listMode: 'ok', // ok | 503 | 403 | hang
  assetMode: 'ok', // ok | 404 | hang
  releasesContent: {},
  ssm: {}
})
let state = defaults()
let log = []

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const github = (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`)
  const auth = req.headers.authorization || ''
  log.push({
    host: req.headers.host,
    from: req.socket.remoteAddress,
    at: Date.now(),
    path: url.pathname,
    query: url.search,
    auth: auth.split(' ')[0] || null,
    authValue: auth ? auth.replace(/\s.*/, ' ***') : null
  })

  const host = req.headers.host
  const list = url.pathname.match(/^\/repos\/curvo\/companion\/releases$/)
  const asset = url.pathname.match(/^\/repos\/curvo\/companion\/releases\/assets\/(\d+)$/)
  const download = url.pathname.match(/^\/curvo\/companion\/releases\/download\/([^/]+)\/(.+)$/)
  const object = url.pathname.match(/^\/asset\/(\d+)$/)

  if (host === 'api.github.com' && list) {
    if (state.listMode === 'hang') return
    if (state.listMode !== 'ok') return json(res, Number(state.listMode), { message: 'mock failure' })
    const page = Number(url.searchParams.get('page') || 1)
    return json(res, 200, state.pages[page - 1] || [])
  }

  if (host === 'api.github.com' && asset) {
    if (state.assetMode === 'hang') return
    if (state.assetMode === '404') return json(res, 404, { message: 'Not Found' })
    res.writeHead(302, {
      Location: `https://objects.githubusercontent.com/asset/${asset[1]}?sig=signed`
    })
    return res.end()
  }

  if (host === 'objects.githubusercontent.com' && object) {
    const content = state.releasesContent[object[1]]
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    return res.end(content || 'binary')
  }

  if (host === 'github.com' && download) {
    const content = state.releasesContent[`${download[1]}/${download[2]}`]
    res.writeHead(content ? 200 : 404)
    return res.end(content || '')
  }

  json(res, 404, { message: 'mock: no route' })
}

https
  .createServer(
    {
      key: fs.readFileSync(path.join(certs, 'server.key')),
      cert: fs.readFileSync(path.join(certs, 'server.pem'))
    },
    github
  )
  .listen(443)

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
    })
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/state') {
        state = Object.assign(state, JSON.parse(body))
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && req.url === '/reset') {
        state = defaults()
        log = []
        return json(res, 200, { ok: true })
      }
      if (req.url === '/log') return json(res, 200, log)
      json(res, 404, {})
    })
  })
  .listen(8081)

// AWS JSON 1.1 protocol, enough for SSM GetParameters
http
  .createServer((req, res) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
    })
    req.on('end', () => {
      const target = req.headers['x-amz-target']
      const input = JSON.parse(body || '{}')
      log.push({ host: 'ssm', target, names: input.Names })
      const Parameters = []
      const InvalidParameters = []
      for (const name of input.Names || []) {
        if (state.ssm[name] === undefined) InvalidParameters.push(name)
        else Parameters.push({ Name: name, Type: 'String', Value: state.ssm[name], Version: 1 })
      }
      res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' })
      res.end(JSON.stringify({ Parameters, InvalidParameters }))
    })
  })
  .listen(8082)

console.log('mock ready')
