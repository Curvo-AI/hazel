# Multi-Stream Deployment Support Plan

## Overview
Enable dynamic deployment streams (production, uat, staging, etc.) using tag-based filtering. Users tag releases with suffixes like `v1.0.0-uat` and clients specify their stream to receive only matching updates.

## Core Design

### Stream Detection from Tag Names
- Parse tag names to extract stream suffix: `vX.Y.Z-{stream}`
- Default stream: `production` (no suffix or `-production`)
- Stream name is everything after the first hyphen in tag
- Examples:
  - `v1.0.0` or `v1.0.0-production` → `production` stream
  - `v1.0.0-uat` → `uat` stream
  - `v1.0.0-staging-hotfix` → `staging-hotfix` stream

### URL Structure Changes

**Current:**
```
/update/:platform/:version
/update/win32/:version/RELEASES
```

**New:**
```
/update/:platform/:version?stream=uat
/update/:platform/:version (defaults to production)
/update/win32/:version/RELEASES?stream=uat
```

### Configuration

Add optional `STREAM` env var:
- When set, server only caches releases matching that stream
- When unset, supports dynamic stream queries
- Useful for dedicated instances per stream

## Implementation Steps

### 1. Update Cache Logic (`lib/cache.js`)

**Add stream parsing utility:**
```js
function parseStream(tagName) {
  // Extract stream from tag like "v1.0.0-uat"
  const parts = tagName.split('-')
  if (parts.length === 1) return 'production'
  return parts.slice(1).join('-')
}
```

**Modify `refreshCache()` method:**
- Change from caching single latest release to caching multiple (one per stream)
- Structure: `this.latestByStream = { production: {...}, uat: {...}, staging: {...} }`
- When filtering releases from GitHub API:
  ```js
  // Group releases by stream
  const releasesByStream = {}
  for (const release of data) {
    if (release.draft) continue
    const stream = parseStream(release.tag_name)
    const isPre = Boolean(pre) === Boolean(release.prerelease)
    if (!isPre) continue
    
    // Keep only the latest for each stream
    if (!releasesByStream[stream]) {
      releasesByStream[stream] = release
    }
  }
  ```

**Add new method:**
```js
loadCacheForStream(stream = 'production') {
  const { latestByStream, refreshCache, isOutdated, lastUpdate } = this
  
  if (!lastUpdate || isOutdated()) {
    await refreshCache()
  }
  
  return Object.assign({}, latestByStream[stream] || {})
}
```

### 2. Update Routes (`lib/routes.js`)

**Extract stream from query params:**
```js
const getStream = (req) => {
  const params = urlHelpers.parse(req.url, true).query
  return params.stream || 'production'
}
```

**Update all route handlers:**

`exports.update`:
```js
exports.update = async (req, res) => {
  const { platform: platformName, version } = req.params
  const stream = getStream(req)
  
  // ... validation ...
  
  const latest = await cache.loadCacheForStream(stream)
  
  // ... rest of logic ...
}
```

`exports.releases`:
```js
exports.releases = async (req, res) => {
  const stream = getStream(req)
  const latest = await cache.loadCacheForStream(stream)
  
  // ... rest of logic ...
}
```

`exports.download`, `exports.downloadPlatform`, `exports.overview`:
- Add stream query param support
- Use `loadCacheForStream(stream)`

### 3. Update Overview Page (`views/index.hbs`)

**Add stream selector:**
```html
<div class="stream-selector">
  <label>Deployment Stream:</label>
  <select id="streamSelect" onchange="window.location.search='?stream='+this.value">
    <option value="production">Production</option>
    <!-- Dynamically populated from available streams -->
  </select>
</div>
```

**Pass available streams to template:**
```js
exports.overview = async (req, res) => {
  const stream = getStream(req)
  const latest = await cache.loadCacheForStream(stream)
  const availableStreams = Object.keys(cache.latestByStream)
  
  const details = {
    // ... existing fields ...
    currentStream: stream,
    availableStreams
  }
  // ...
}
```

### 4. Backward Compatibility

- Existing clients without `?stream=` param get `production` stream
- Existing release tags without suffix treated as `production`
- No breaking changes to current behavior

### 5. Client Integration Example

**Electron app code:**
```js
const { app, autoUpdater } = require('electron')

const server = '<hazel-deployment-url>'
const stream = process.env.UPDATE_STREAM || 'production'
const url = `${server}/update/${process.platform}/${app.getVersion()}?stream=${stream}`

autoUpdater.setFeedURL({ url })
```

**Users control stream via environment variable:**
```bash
# Production users
UPDATE_STREAM=production ./app

# UAT testers
UPDATE_STREAM=uat ./app

# Staging
UPDATE_STREAM=staging ./app
```

### 6. Testing Strategy

**Unit tests (`test/cache.test.js`):**
- Test stream parsing from various tag formats
- Test caching multiple streams simultaneously
- Test `loadCacheForStream()` returns correct release

**Integration tests:**
- Create test releases with different stream tags
- Verify `/update/darwin/1.0.0?stream=uat` returns UAT release
- Verify `/update/darwin/1.0.0` returns production release
- Verify RELEASES file filtering per stream

### 7. Documentation Updates

**README.md additions:**
```markdown
## Deployment Streams

Support multiple deployment streams (production, UAT, staging, etc.) using tag-based filtering.

### Tagging Releases

- Production: `v1.0.0` or `v1.0.0-production`
- UAT: `v1.0.0-uat`
- Staging: `v1.0.0-staging`
- Custom: `v1.0.0-{your-stream-name}`

### Client Configuration

Specify stream via query parameter:
```js
const url = `${server}/update/${platform}/${version}?stream=uat`
```

Default stream is `production` if not specified.

### Environment Variables

- `STREAM`: Lock server to specific stream (optional)
```

## Edge Cases to Handle

1. **No releases for requested stream**: Return 204 (no update available)
2. **Invalid stream name**: Treat as production
3. **Mixed pre-release and production streams**: Respect PRE env var per stream
4. **Cache invalidation**: Refresh all streams, not just one
5. **Private repos**: Ensure token works across all streams

## Performance Considerations

- Cache all streams simultaneously (single GitHub API call)
- Memory usage increases linearly with number of active streams
- Typical scenario: 2-4 streams (production, staging, uat, dev)
- GitHub API rate limits apply to all streams combined

## Migration Path

1. Deploy updated Hazel (backward compatible)
2. Existing deployments continue working (production stream)
3. Create new releases with stream tags for testing
4. Update client apps to use stream query param
5. Gradually roll out to different user groups