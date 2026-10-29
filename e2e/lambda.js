// Drives the image through the Lambda Runtime Interface Emulator so requests
// go API Gateway v2 event -> Lambda Web Adapter -> server.js, as on AWS.
// Usage: node lambda.js
const { spawnSync } = require('child_process')

const E = __dirname
const ADMIN = 'http://localhost:18081'
const MOCK_IP = '172.30.0.10'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const docker = (...args) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' })
  return (r.stdout || '') + (r.stderr || '')
}
const admin = async (route, body) => (await fetch(ADMIN + route, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) })).json()

let assetId = 5000
const release = tag => {
  const base = tag.replace(/^v/, '')
  const v = base.replace(/-.*/, '')
  return {
    tag_name: tag, body: `notes ${tag}`, published_at: '2026-10-01T00:00:00Z', draft: false, prerelease: false,
    assets: [`Curvo-darwin-arm64-${v}.zip`, 'Curvo.dmg', 'RELEASES', `curvo-${base}-full.nupkg`].map(name => {
      const id = ++assetId
      return { id, name, url: `https://api.github.com/repos/curvo/companion/releases/assets/${id}`, browser_download_url: `https://github.com/curvo/companion/releases/download/${tag}/${name}`, content_type: 'application/octet-stream', size: 1 }
    })
  }
}
const pages = [[release('v1.4.1'), release('v1.4.1-sv')]]
const releasesContent = {}
for (const r of pages[0]) {
  const id = r.assets.find(a => a.name === 'RELEASES').id
  releasesContent[String(id)] = `ABC curvo-${r.tag_name.slice(1)}-full.nupkg 100`
}

const event = (rawPath, rawQueryString = '') => ({
  version: '2.0', routeKey: 'ANY /{proxy+}', rawPath, rawQueryString,
  headers: { host: 'abc123.execute-api.eu-west-2.amazonaws.com', 'x-forwarded-proto': 'https', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
  requestContext: {
    accountId: '123456789012', apiId: 'abc123', domainName: 'abc123.execute-api.eu-west-2.amazonaws.com', domainPrefix: 'abc123',
    http: { method: 'GET', path: rawPath, protocol: 'HTTP/1.1', sourceIp: '203.0.113.1', userAgent: 'Mozilla/5.0' },
    requestId: `req-${Date.now()}`, routeKey: 'ANY /{proxy+}', stage: '$default', time: '29/Oct/2026:17:00:00 +0000', timeEpoch: Date.now()
  },
  isBase64Encoded: false
})

const invoke = async (port, rawPath, query) => {
  const started = Date.now()
  try {
    const res = await fetch(`http://localhost:${port}/2015-03-31/functions/function/invocations`, {
      method: 'POST', body: JSON.stringify(event(rawPath, query)), signal: AbortSignal.timeout(40000)
    })
    const text = await res.text()
    let out
    try { out = JSON.parse(text) } catch { out = { raw: text } }
    if (out.isBase64Encoded && out.body) out.body = Buffer.from(out.body, 'base64').toString()
    return Object.assign(out, { ms: Date.now() - started })
  } catch {
    return { statusCode: 'HUNG', ms: Date.now() - started }
  }
}

const start = async (image, name, port, env) => {
  docker('rm', '-f', name)
  const envArgs = Object.entries(Object.assign({
    NODE_EXTRA_CA_CERTS: '/e2e/certs/ca.pem', USE_LOCAL_ENV: 'true', ACCOUNT: 'curvo', REPOSITORY: 'companion', PORT: '3000'
  }, env)).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  docker('run', '-d', '--name', name, '--network', 'hazel-e2e',
    '--add-host', `api.github.com:${MOCK_IP}`, '--add-host', `github.com:${MOCK_IP}`, '--add-host', `objects.githubusercontent.com:${MOCK_IP}`,
    '-v', `${E}:/e2e:ro`, '-p', `${port}:8080`, ...envArgs,
    '--entrypoint', '/usr/local/bin/aws-lambda-rie', image, 'node', 'server.js')
  await sleep(1500)
}

const header = (r, name) => r.headers && (r.headers[name] || r.headers[name[0].toUpperCase() + name.slice(1)])
const json = r => {
  try {
    return JSON.parse(r.body)
  } catch {
    return {}
  }
}

const main = async () => {
  const image = 'hazel-e2e:current'
  const checks = []
  const check = (name, r, pass) => {
    checks.push(pass)
    const loc = header(r, 'location')
    const body = typeof r.body === 'string' ? r.body.slice(0, 90).replace(/\s+/g, ' ') : ''
    console.log(`${pass ? 'PASS' : 'FAIL'} | ${name} | ${r.statusCode} ${loc ? '→ ' + loc + ' ' : ''}${body} (${(r.ms / 1000).toFixed(1)}s)`)
  }
  const apiBase = 'https://abc123.execute-api.eu-west-2.amazonaws.com'

  await admin('/reset', {})
  await admin('/state', { pages, releasesContent })
  await start(image, 'hazel-e2e-lambda', 18300, { TOKEN: 'test-token' })
  let r = await invoke(18300, '/update/darwin_arm64/1.4.0')
  check('update via API Gateway host', r, r.statusCode === 200 && json(r).url === `${apiBase}/download/darwin_arm64?update=true`)
  r = await invoke(18300, '/update/darwin_arm64/1.4.0-sv')
  check('sv update', r, r.statusCode === 200 && json(r).name === 'v1.4.1-sv')
  r = await invoke(18300, '/update/win32/1.4.0-sv/RELEASES')
  check('sv RELEASES', r, r.statusCode === 200 && r.body.includes(`${apiBase}/download/file/curvo-1.4.1-sv-full.nupkg?stream=sv`))
  r = await invoke(18300, '/download/darwin_arm64', 'update=true')
  check('private download redirect', r, r.statusCode === 302 && String(header(r, 'location')).startsWith('https://objects.githubusercontent.com/'))
  r = await invoke(18300, '/')
  check('overview', r, r.statusCode === 200 && r.body.includes('v1.4.1'))
  docker('rm', '-f', 'hazel-e2e-lambda')

  // Readiness must not depend on GitHub, or a cold start during an outage never finishes init
  await admin('/reset', {})
  await admin('/state', { pages, releasesContent, listMode: '503' })
  await start(image, 'hazel-e2e-lambda', 18301, {})
  r = await invoke(18301, '/update/darwin_arm64/1.4.0')
  check('cold start during GitHub outage', r, r.statusCode === 503 && r.ms < 10000)
  await admin('/state', { listMode: 'ok' })
  r = await invoke(18301, '/update/darwin_arm64/1.4.0')
  check('recovers when GitHub is back', r, r.statusCode === 200 && json(r).name === 'v1.4.1')
  docker('rm', '-f', 'hazel-e2e-lambda')

  const failures = checks.filter(pass => !pass).length
  console.log(`\n${failures} failures`)
  process.exit(failures ? 1 : 0)
}

main()
