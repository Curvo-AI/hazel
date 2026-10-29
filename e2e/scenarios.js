// Black-box E2E for Hazel: runs each scenario against fresh containers of the
// current image and a baseline image, with GitHub and SSM replaced by mock.js.
// Checks are asserted on the current image; the baseline is shown alongside.
// Run through e2e/run.sh, which builds the images and starts the mock.
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const E = __dirname
const ADMIN = 'http://localhost:18081'
const MOCK_IP = '172.30.0.10'
const IMAGES = { current: 'hazel-e2e:current', baseline: 'hazel-e2e:baseline' }
const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const docker = (...args) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' })
  return (r.stdout || '') + (r.stderr || '')
}

// Fixtures shaped like curvo-companion releases
let assetId = 1000
const release = (tag, extra = {}) => {
  const base = tag.replace(/^v/, '')
  const v = base.replace(/-.*/, '')
  const names = [`Curvo-darwin-arm64-${v}.zip`, 'Curvo.dmg', `Curvo-${v}.Setup.exe`, 'RELEASES', `curvo-${base}-full.nupkg`]
  return Object.assign({
    tag_name: tag,
    body: `notes ${tag}`,
    published_at: '2026-10-01T00:00:00Z',
    draft: false,
    prerelease: false,
    assets: names.map(name => {
      const id = ++assetId
      return {
        id,
        name,
        url: `https://api.github.com/repos/curvo/companion/releases/assets/${id}`,
        browser_download_url: `https://github.com/curvo/companion/releases/download/${tag}/${name}`,
        content_type: 'application/octet-stream',
        size: 52000000
      }
    })
  }, extra)
}
const releasesContentFor = pages => {
  const content = {}
  for (const r of pages.flat()) {
    const base = r.tag_name.replace(/^v/, '')
    const file = `E3F0A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8 curvo-${base}-full.nupkg 104857600`
    const asset = r.assets.find(a => a.name === 'RELEASES')
    content[`${r.tag_name}/RELEASES`] = file
    content[String(asset.id)] = file
  }
  return content
}
const standardPages = () => [[release('v1.4.1'), release('v1.4.1-sv'), release('v1.4.0-cc'), release('v1.4.0')]]

const admin = async (route, body) => {
  const res = await fetch(ADMIN + route, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return res.json()
}
const setPages = pages => admin('/state', { pages, releasesContent: releasesContentFor(pages) })
const listFetches = async () => (await admin('/log')).filter(e => e.host === 'api.github.com' && e.path.endsWith('/releases'))

let port = 18100
const startHazel = async (image, env = {}, { wait = true } = {}) => {
  const p = port++
  const name = `hazel-e2e-${p}`
  const fullEnv = Object.assign(
    { NODE_EXTRA_CA_CERTS: '/e2e/certs/ca.pem', USE_LOCAL_ENV: 'true', ACCOUNT: 'curvo', REPOSITORY: 'companion' },
    env
  )
  const envArgs = Object.entries(fullEnv).filter(([, v]) => v !== null).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  docker('rm', '-f', name)
  docker(
    'run', '-d', '--name', name, '--network', 'hazel-e2e',
    '--add-host', `api.github.com:${MOCK_IP}`, '--add-host', `github.com:${MOCK_IP}`,
    '--add-host', `objects.githubusercontent.com:${MOCK_IP}`,
    '-v', `${E}:/e2e:ro`, '-p', `${p}:8080`, ...envArgs, image
  )
  const h = {
    port: p,
    base: `http://localhost:${p}`,
    logs: () => docker('logs', name),
    stop: () => docker('rm', '-f', name),
    ready: false
  }
  if (wait) {
    for (let i = 0; i < 60; i++) {
      if (/listening on port/i.test(h.logs())) {
        h.ready = true
        break
      }
      if (/exited/i.test(docker('inspect', '-f', '{{.State.Status}}', name))) break
      await sleep(250)
    }
  }
  return h
}

const get = async (base, route, { ua, timeout = 25000 } = {}) => {
  const started = Date.now()
  try {
    const res = await fetch(base + route, {
      redirect: 'manual',
      headers: ua ? { 'user-agent': ua } : {},
      signal: AbortSignal.timeout(timeout)
    })
    const body = await res.text()
    let json = null
    try { json = JSON.parse(body) } catch {}
    return { status: res.status, location: res.headers.get('location'), body, json, ms: Date.now() - started }
  } catch (error) {
    return { status: 'HUNG', ms: Date.now() - started, error: error.name }
  }
}

const show = r => {
  if (r.status === 'HUNG') return `no response after ${(r.ms / 1000).toFixed(1)}s`
  const bits = [String(r.status)]
  if (r.json && r.json.name) bits.push(r.json.name)
  if (r.json && r.json.error) bits.push(r.json.error)
  if (r.location) bits.push(`→ ${r.location.replace(/^https:\/\/github\.com\/curvo\/companion\/releases\/download\//, 'gh:')}`)
  if (r.ms > 1000) bits.push(`(${(r.ms / 1000).toFixed(1)}s)`)
  return bits.join(' ')
}

// Each scenario returns checks: { check, expect, actual, pass }
const scenarios = {
  async 'public-happy-path'(image) {
    await setPages(standardPages())
    const h = await startHazel(image)
    const c = []
    const add = (check, expect, r, pass, actual) => c.push({ check, expect, actual: actual || show(r), pass })
    let r
    r = await get(h.base, '/update/darwin_arm64/1.4.0')
    add('old prod client gets update', '200 v1.4.1 zip', r, r.status === 200 && r.json.name === 'v1.4.1' && r.json.url.endsWith('/v1.4.1/Curvo-darwin-arm64-1.4.1.zip'), `${show(r)} ${r.json && r.json.url ? r.json.url.split('/').slice(-2).join('/') : ''}`)
    r = await get(h.base, '/update/darwin_arm64/1.4.1')
    add('current prod client', '204', r, r.status === 204)
    r = await get(h.base, '/update/darwin_arm64/1.4.0-sv')
    add('sv client (version suffix)', '200 v1.4.1-sv', r, r.status === 200 && r.json.name === 'v1.4.1-sv')
    r = await get(h.base, '/update/darwin_arm64/1.4.1-sv')
    add('current sv client', '204', r, r.status === 204)
    r = await get(h.base, '/update/darwin_arm64/1.3.0?stream=cc')
    add('?stream=cc', '200 v1.4.0-cc', r, r.status === 200 && r.json.name === 'v1.4.0-cc')
    r = await get(h.base, '/update/darwin_arm64/1.4.1?stream=uat.beta')
    add('invalid ?stream', '400 stream_invalid', r, r.status === 400)
    r = await get(h.base, '/update/darwin_arm64/not-a-version')
    add('invalid version', '500 version_invalid', r, r.status === 500 && r.json.error === 'version_invalid')
    r = await get(h.base, '/update/linux/1.0.0')
    add('invalid platform', '500 invalid_platform', r, r.status === 500 && r.json.error === 'invalid_platform')
    r = await get(h.base, '/update/exe/1.4.0')
    add('win32 alias exe', '200 v1.4.1', r, r.status === 200 && r.json.url.endsWith('Curvo-1.4.1.Setup.exe'))
    r = await get(h.base, '/update/win32/1.4.0/RELEASES')
    add('RELEASES prod', 'GitHub nupkg URL', r, r.status === 200 && r.body.includes('https://github.com/curvo/companion/releases/download/v1.4.1/curvo-1.4.1-full.nupkg'), `${r.status} ${r.body ? r.body.split(' ')[1] : ''}`)
    r = await get(h.base, '/update/win32/1.4.0-sv/RELEASES')
    add('RELEASES sv', 'sv nupkg URL', r, r.status === 200 && r.body.includes('/v1.4.1-sv/curvo-1.4.1-sv-full.nupkg'), `${r.status} ${r.body ? r.body.split(' ')[1] : ''}`)
    r = await get(h.base, '/download', { ua: UA.mac })
    add('/download Mac UA', '302 dmg', r, r.status === 302 && r.location.endsWith('/v1.4.1/Curvo.dmg'))
    r = await get(h.base, '/download', { ua: UA.windows })
    add('/download Windows UA', '302 exe', r, r.status === 302 && r.location.endsWith('Curvo-1.4.1.Setup.exe'))
    r = await get(h.base, '/download', { ua: UA.linux })
    add('/download Linux UA', '404', r, r.status === 404)
    r = await get(h.base, '/download/darwin_arm64?update=true')
    add('/download/darwin_arm64', '302 zip', r, r.status === 302 && r.location.endsWith('Curvo-darwin-arm64-1.4.1.zip'))
    r = await get(h.base, '/download/dmg?stream=sv')
    add('/download/dmg?stream=sv', '302 sv dmg', r, r.status === 302 && r.location.endsWith('/v1.4.1-sv/Curvo.dmg'))
    r = await get(h.base, '/download/file/Curvo.dmg')
    add('/download/file/Curvo.dmg', '302', r, r.status === 302 && r.location.endsWith('/v1.4.1/Curvo.dmg'))
    r = await get(h.base, '/download/file/nope.zip')
    add('/download/file missing', '404', r, r.status === 404)
    r = await get(h.base, '/')
    add('overview page', '200 shows v1.4.1', r, r.status === 200 && r.body.includes('v1.4.1') && r.body.includes('curvo/companion'), `${r.status} ${/v1\.4\.1/.test(r.body || '') ? 'shows v1.4.1' : 'missing version'}`)
    const fetches = await listFetches()
    c.push({ check: 'GitHub list calls for 19 requests', expect: '1', actual: String(fetches.length), pass: fetches.length === 1 })
    h.stop()
    return c
  },

  async 'private-downloads'(image) {
    await setPages(standardPages())
    const h = await startHazel(image, { TOKEN: 'test-token' })
    const c = []
    const add = (check, expect, r, pass, actual) => c.push({ check, expect, actual: actual || show(r), pass })
    let r = await get(h.base, '/update/darwin_arm64/1.4.0')
    const proxied = `https://localhost:${h.port}/download/darwin_arm64?update=true`
    add('update URL points at Hazel proxy', proxied.replace(/:\d+/, ':PORT'), r, r.status === 200 && r.json.url === proxied, r.json ? r.json.url.replace(/:\d+/, ':PORT') : show(r))
    // The cache fetched RELEASES via the API, which redirects to the signed host
    const signedHostLog = (await admin('/log')).filter(e => e.host === 'objects.githubusercontent.com')
    await admin('/reset', {})
    await setPages(standardPages())
    r = await get(h.base, '/download/darwin_arm64?update=true')
    let log = (await admin('/log')).filter(e => (e.path || '').includes('/assets/'))
    add('proxy redirects to signed URL', '302 objects.githubusercontent.com', r, r.status === 302 && r.location.startsWith('https://objects.githubusercontent.com/asset/'))
    c.push({ check: 'token sent as', expect: 'Authorization: token (not URL basic auth)', actual: log.map(e => e.authValue).join(', ') || 'no request', pass: log.length === 1 && log[0].auth === 'token' })
    r = await get(h.base, '/update/win32/1.4.0-sv/RELEASES')
    const want = `https://localhost:${h.port}/download/file/curvo-1.4.1-sv-full.nupkg?stream=sv`
    add('RELEASES sv rewritten to proxy', 'proxy URL with ?stream=sv', r, r.status === 200 && r.body.includes(want), `${r.status} ${r.body ? r.body.split(' ')[1].replace(/:\d+/, ':PORT') : ''}`)
    r = await get(h.base, '/download/file/curvo-1.4.1-sv-full.nupkg?stream=sv')
    add('nupkg proxy download', '302 signed URL', r, r.status === 302 && r.location.includes('objects.githubusercontent.com'))
    c.push({ check: 'RELEASES fetched from signed host', expect: 'no Authorization header leaked cross-origin', actual: signedHostLog.map(e => e.auth || 'none').join(', ') || 'not fetched', pass: signedHostLog.length > 0 && signedHostLog.every(e => !e.auth) })
    await admin('/state', { assetMode: '404' })
    r = await get(h.base, '/download/darwin_arm64?update=true')
    add('GitHub asset 404', '502', r, r.status === 502, `${show(r)}${r.location === 'null' ? ' (Location: "null")' : ''}`)
    await admin('/state', { assetMode: 'hang' })
    r = await get(h.base, '/download/darwin_arm64?update=true', { timeout: 15000 })
    add('GitHub asset hangs', '502 after ~5s', r, r.status === 502 && r.ms < 7000)
    await admin('/state', { assetMode: 'ok' })
    h.stop()
    return c
  },

  async 'stream-tag-leak'(image) {
    await setPages([[release('v1.2.4-uat.1'), release('v1.2.3')]])
    const h = await startHazel(image)
    const c = []
    let r = await get(h.base, '/update/darwin_arm64/1.2.3')
    c.push({ check: 'prod client on 1.2.3, newest tag v1.2.4-uat.1', expect: '204 (UAT not served)', actual: show(r), pass: r.status === 204 })
    r = await get(h.base, '/download/dmg')
    c.push({ check: '/download/dmg', expect: '302 v1.2.3 dmg', actual: show(r), pass: r.status === 302 && r.location.includes('/v1.2.3/') })
    c.push({ check: 'skip logged', expect: 'v1.2.4-uat.1', actual: (h.logs().match(/Skipping release \S+/g) || ['none']).join(', '), pass: /Skipping release v1\.2\.4-uat\.1/.test(h.logs()) })
    h.stop()
    return c
  },

  async 'non-semver-tag'(image) {
    await setPages([[release('nightly'), release('v1.2.3')]])
    const h = await startHazel(image)
    const c = []
    let r = await get(h.base, '/update/darwin_arm64/1.2.2')
    c.push({ check: 'newest tag "nightly", client 1.2.2', expect: '200 v1.2.3', actual: show(r), pass: r.status === 200 && r.json.name === 'v1.2.3' })
    r = await get(h.base, '/update/darwin_arm64/1.2.3')
    c.push({ check: 'server still up afterwards', expect: '204', actual: show(r), pass: r.status === 204 })
    const crash = (h.logs().match(/TypeError: [^\n]+/) || [])[0]
    c.push({ check: 'process crash in log', expect: 'none', actual: crash || 'none', pass: !crash })
    h.stop()
    return c
  },

  async 'concurrent-cold-requests'(image) {
    await setPages(standardPages())
    const h = await startHazel(image)
    const results = await Promise.all(Array.from({ length: 20 }, () => get(h.base, '/update/darwin_arm64/1.4.0')))
    const fetches = await listFetches()
    h.stop()
    return [
      { check: '20 concurrent cold requests succeed', expect: '20 × 200', actual: `${results.filter(r => r.status === 200).length} × 200`, pass: results.every(r => r.status === 200) },
      { check: 'GitHub list calls', expect: '1', actual: String(fetches.length), pass: fetches.length === 1 }
    ]
  },

  async 'cold-start-outage'(image) {
    const c = []
    for (const [mode, expectMs, expectCalls] of [['503', 4000, 3], ['403', 1000, 1], ['hang', 20000, 3]]) {
      await admin('/reset', {})
      await setPages(standardPages())
      await admin('/state', { listMode: mode })
      const h = await startHazel(image)
      const r = await get(h.base, '/update/darwin_arm64/1.4.0', { timeout: 25000 })
      const calls = (await listFetches()).length
      c.push({ check: `GitHub ${mode}, empty cache`, expect: `503 cache_unavailable < ${expectMs / 1000}s`, actual: show(r), pass: r.status === 503 && r.json.error === 'cache_unavailable' && r.ms < expectMs })
      c.push({ check: `GitHub ${mode}: attempts`, expect: String(expectCalls), actual: String(calls), pass: calls === expectCalls })
      await admin('/state', { listMode: 'ok' })
      const after = await get(h.base, '/update/darwin_arm64/1.4.0', { timeout: 25000 })
      c.push({ check: `GitHub ${mode}: recovers when GitHub is back`, expect: '200 v1.4.1', actual: show(after), pass: after.status === 200 && after.json.name === 'v1.4.1' })
      h.stop()
    }
    return c
  },

  async 'stale-fallback'(image) {
    await setPages(standardPages())
    const h = await startHazel(image, { INTERVAL: '0.05' }) // 3 seconds
    const c = []
    let r = await get(h.base, '/update/darwin_arm64/1.4.0')
    c.push({ check: 'warm cache', expect: '200 v1.4.1', actual: show(r), pass: r.status === 200 })
    await admin('/state', { listMode: '503' })
    await sleep(3500)
    let before = (await listFetches()).length
    r = await get(h.base, '/update/darwin_arm64/1.4.0')
    c.push({ check: 'GitHub 503 after interval', expect: '200 v1.4.1 (stale)', actual: show(r), pass: r.status === 200 && r.json.name === 'v1.4.1' })
    before = (await listFetches()).length
    r = await get(h.base, '/update/darwin_arm64/1.4.0')
    const after = (await listFetches()).length
    c.push({ check: 'next request inside back-off', expect: '200 fast, no GitHub call', actual: `${show(r)}, ${after - before} GitHub calls`, pass: r.status === 200 && r.ms < 500 && after === before })
    await setPages([[release('v1.4.2'), ...standardPages()[0]]])
    await admin('/state', { listMode: 'ok' })
    await sleep(3500)
    r = await get(h.base, '/update/darwin_arm64/1.4.0')
    c.push({ check: 'GitHub back + new release', expect: '200 v1.4.2', actual: show(r), pass: r.status === 200 && r.json.name === 'v1.4.2' })
    await admin('/state', { listMode: '403' })
    await sleep(3500)
    r = await get(h.base, '/update/darwin_arm64/1.4.0')
    c.push({ check: 'GitHub 403 (rate limit) after interval', expect: '200 v1.4.2 (stale) < 1s', actual: show(r), pass: r.status === 200 && r.json.name === 'v1.4.2' && r.ms < 1000 })
    await admin('/state', { listMode: 'ok' })
    h.stop()
    return c
  },

  async 'pagination'(image) {
    const page1 = Array.from({ length: 100 }, (v, i) => release(`v3.0.${99 - i}`))
    await setPages([page1, [release('v2.9.0-sv')]])
    const h = await startHazel(image)
    const r = await get(h.base, '/update/darwin_arm64/2.0.0-sv')
    const prod = await get(h.base, '/update/darwin_arm64/3.0.0')
    h.stop()
    return [
      { check: 'sv release on page 2', expect: '200 v2.9.0-sv', actual: show(r), pass: r.status === 200 && r.json.name === 'v2.9.0-sv' },
      { check: 'prod picks newest on page 1', expect: '200 v3.0.99', actual: show(prod), pass: prod.status === 200 && prod.json.name === 'v3.0.99' }
    ]
  },

  async 'no-releases'(image) {
    await setPages([[]])
    const h = await startHazel(image)
    const u = await get(h.base, '/update/darwin_arm64/1.0.0')
    const d = await get(h.base, '/download/dmg')
    const o = await get(h.base, '/')
    h.stop()
    return [
      { check: '/update with no releases', expect: '204', actual: show(u), pass: u.status === 204 },
      { check: '/download with no releases', expect: '404', actual: show(d), pass: d.status === 404 },
      { check: 'overview with no releases', expect: 'responds', actual: show(o), pass: o.status !== 'HUNG' }
    ]
  },

  async 'ssm-config'(image) {
    const c = []
    const ssmEnv = {
      USE_LOCAL_ENV: null, ACCOUNT: null, REPOSITORY: null,
      AWS_ENDPOINT_URL_SSM: `http://${MOCK_IP}:8082`, AWS_REGION: 'eu-west-2',
      AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test'
    }
    for (const [label, prefix] of [['custom prefix', '/custom/hazel'], ['default prefix', null]]) {
      const used = prefix || '/sst/hazel/production/secrets'
      await admin('/reset', {})
      await setPages(standardPages())
      await admin('/state', { ssm: { [`${used}/ACCOUNT`]: 'curvo', [`${used}/REPOSITORY`]: 'companion', [`${used}/TOKEN`]: 'ssm-token' } })
      const h = await startHazel(image, Object.assign({}, ssmEnv, { SSM_PARAMETER_PREFIX: prefix }))
      const names = (await admin('/log')).filter(e => e.host === 'ssm').flatMap(e => e.names || [])
      c.push({ check: `${label}: SSM names read`, expect: `${used}/{ACCOUNT,REPOSITORY,TOKEN}`, actual: names.length ? `${names[0].replace(/\/ACCOUNT$/, '')}/{…} (${names.length})` : 'none', pass: names.length === 3 && names.every(n => n.startsWith(used + '/')) })
      if (!h.ready) {
        c.push({ check: `${label}: server starts`, expect: 'listening', actual: `did not start: ${h.logs().split('\n').filter(Boolean).slice(-1)[0]}`, pass: false })
        h.stop()
        continue
      }
      const r = await get(h.base, '/download/darwin_arm64?update=true')
      const assetLog = (await admin('/log')).filter(e => (e.path || '').includes('/assets/'))
      c.push({ check: `${label}: serves with SSM token`, expect: '302 via token from SSM', actual: `${show(r).split(' →')[0]}, auth ${assetLog.map(e => e.authValue).join(',') || 'none'}`, pass: r.status === 302 && assetLog.some(e => e.auth === 'token') })
      h.stop()
    }
    return c
  }
}

const main = async () => {
  const filter = process.argv[2]
  const out = []
  for (const [name, fn] of Object.entries(scenarios)) {
    if (filter && !name.includes(filter)) continue
    const row = { scenario: name, results: {} }
    for (const [label, image] of Object.entries(IMAGES)) {
      await admin('/reset', {})
      process.stdout.write(`${name} on ${label}... `)
      const started = Date.now()
      try {
        row.results[label] = await fn(image)
      } catch (error) {
        row.results[label] = [{ check: 'scenario crashed', expect: '-', actual: String(error.stack || error), pass: false }]
      }
      console.log(`${((Date.now() - started) / 1000).toFixed(1)}s`)
    }
    out.push(row)
  }
  fs.writeFileSync(path.join(E, `results${filter ? '-' + filter : ''}.json`), JSON.stringify(out, null, 2))
  let failures = 0
  for (const row of out) {
    console.log(`\n## ${row.scenario}`)
    const current = row.results.current
    const baseline = row.results.baseline || []
    current.forEach((check, i) => {
      if (!check.pass) failures++
      const b = baseline[i] ? baseline[i].actual : '-'
      console.log(`${check.pass ? 'PASS' : 'FAIL'} | ${check.check} | want ${check.expect} | current: ${check.actual} | baseline: ${b}`)
    })
  }
  console.log(`\n${failures} failures`)
  process.exit(failures ? 1 : 0)
}

main()
