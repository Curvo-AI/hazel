// Compares the current image (local, real GitHub data) with the live
// production endpoint for the same requests. Read-only GETs; redirects are not
// followed. Run through `e2e/run.sh parity` with TOKEN set, or set CANDIDATE to
// a deployed Hazel URL to compare that instead of a local container.
const { spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PROD = 'https://lb1xhk0l7l.execute-api.eu-west-2.amazonaws.com'
const PORT = 18200
const CANDIDATE = (process.env.CANDIDATE || '').replace(/\/$/, '')
const LOCAL = CANDIDATE || `http://localhost:${PORT}`
// Hazel builds absolute URLs from the Host header it receives
const LOCAL_BASE = CANDIDATE || `https://localhost:${PORT}`
const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
}
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = s => crypto.createHash('sha1').update(s || '').digest('hex').slice(0, 8)

const requests = [
  ...['darwin_arm64', 'darwin', 'win32', 'exe', 'dmg', 'mac'].flatMap(p => ['1.0.0', '2.4.9', '2.4.10'].map(v => [`/update/${p}/${v}`])),
  ['/update/darwin_arm64/2.4.0-sv'], ['/update/darwin_arm64/2.4.10-sv'],
  ['/update/darwin_arm64/2.4.0-fsc'], ['/update/darwin_arm64/2.4.10-fsc'],
  ...['fsc', 'cc', 'demo', 'test', 'sv', 'production', 'nonexistent'].map(s => [`/update/darwin_arm64/2.0.0?stream=${s}`]),
  ['/update/exe/2.0.0?stream=sv'],
  ['/update/darwin_arm64/2.4.10?stream=a.b'], ['/update/darwin_arm64/abc'], ['/update/linux/2.0.0'],
  ['/update/win32/2.4.9/RELEASES'], ['/update/win32/2.4.0-sv/RELEASES'], ['/update/win32/2.0.0/RELEASES?stream=fsc'],
  ['/update/win32/2.0.0/RELEASES?stream=cc'],
  ['/download', 'mac'], ['/download', 'windows'], ['/download', 'linux'], ['/download?update=true', 'mac'],
  ['/download/darwin_arm64?update=true'], ['/download/mac_arm64'], ['/download/dmg'], ['/download/mac'], ['/download/win32'],
  ['/download/exe?stream=sv'], ['/download/dmg?stream=fsc'], ['/download/linux'],
  ['/download/file/Curvo.dmg'], ['/download/file/RELEASES'], ['/download/file/does-not-exist.zip'],
  ['/']
]

const normalise = (base, r) => {
  const strip = s => (s || '').split(base).join('BASE')
  const out = { status: r.status }
  // API Gateway adds text/plain when Hazel sets no content type
  const contentType = r.contentType || 'text/plain; charset=utf-8'
  out.contentType = contentType
  if (r.location) {
    // Signed asset URLs carry per-request query strings
    out.location = strip(r.location).split('?')[0]
  }
  if (r.json) {
    out.name = r.json.name
    out.pub_date = r.json.pub_date
    out.notes = r.json.notes === undefined ? undefined : hash(r.json.notes)
    out.url = r.json.url === undefined ? undefined : strip(r.json.url)
    out.error = r.json.error
  } else if (r.body && r.status === 200 && /RELEASES/.test(r.route)) {
    // Exact bytes: Squirrel's RELEASES starts with a BOM, which trim() would hide
    out.body = JSON.stringify(strip(r.body))
  } else if (r.route === '/') {
    out.versions = [...new Set((r.body.match(/v\d+\.\d+\.\d+[\w.-]*/g) || []))].sort().join(',')
  } else if (r.body) {
    out.body = r.body.slice(0, 80)
  }
  return out
}

const get = async (base, route, ua) => {
  try {
    const res = await fetch(base + route, {
      redirect: 'manual',
      headers: ua ? { 'user-agent': UA[ua] } : {},
      signal: AbortSignal.timeout(30000)
    })
    const body = Buffer.from(await res.arrayBuffer()).toString()
    let json = null
    try { json = JSON.parse(body) } catch {}
    return { route, status: res.status, location: res.headers.get('location'), contentType: res.headers.get('content-type'), body, json }
  } catch (error) {
    return { route, status: `ERROR ${error.name}` }
  }
}

const main = async () => {
  if (!CANDIDATE) {
    docker('rm', '-f', 'hazel-e2e-parity')
    docker('run', '-d', '--name', 'hazel-e2e-parity', '-p', `${PORT}:8080`,
      '-e', 'USE_LOCAL_ENV=true', '-e', 'ACCOUNT=Curvo-AI', '-e', 'REPOSITORY=curvo-companion',
      '-e', `TOKEN=${process.env.TOKEN}`, 'hazel-e2e:current')
    for (let i = 0; i < 60 && !/listening/.test(docker('logs', 'hazel-e2e-parity').stdout); i++) await sleep(250)
  }

  const rows = []
  let diffs = 0
  for (const [route, ua] of requests) {
    const [prod, local] = await Promise.all([get(PROD, route, ua), get(LOCAL, route, ua)])
    const p = normalise(PROD, prod)
    const l = normalise(LOCAL_BASE, local)
    const same = JSON.stringify(p) === JSON.stringify(l)
    if (!same) diffs++
    rows.push({ route: route + (ua ? ` [${ua} UA]` : ''), same, prod: p, local: l })
    console.log(`${same ? 'SAME' : 'DIFF'} ${route}${ua ? ` [${ua}]` : ''}  ${JSON.stringify(l)}${same ? '' : `\n     prod: ${JSON.stringify(p)}`}`)
  }
  if (!CANDIDATE) {
    const logs = docker('logs', 'hazel-e2e-parity')
    console.log('\nlocal container warnings/errors:\n' + (logs.stdout + logs.stderr).split('\n').filter(l => /skip|warn|error|fail/i.test(l)).join('\n'))
    docker('rm', '-f', 'hazel-e2e-parity')
  }
  fs.writeFileSync(path.join(__dirname, 'parity.json'), JSON.stringify(rows, null, 2))
  console.log(`\n${rows.length} requests, ${diffs} differences`)
  process.exit(diffs ? 1 : 0)
}

main()
