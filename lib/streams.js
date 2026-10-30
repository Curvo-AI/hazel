const semver = require('semver')

const productionStream = 'production'
const streamPattern = /^[a-zA-Z0-9_-]+$/

const normaliseStream = stream => {
  if (!stream || stream === productionStream) {
    return productionStream
  }

  return stream
}

const validateStream = stream => {
  return typeof stream === 'string' && streamPattern.test(stream)
}

// Invalid values fall back to `invalid`: production for client versions, but
// null for release tags so a malformed tag is never served to production.
const parseStreamFromSemver = (value, invalid) => {
  const version = semver.valid(value)

  if (!version) {
    return invalid
  }

  const parsed = semver.parse(version)

  if (!parsed || parsed.prerelease.length === 0) {
    return productionStream
  }

  const stream = normaliseStream(parsed.prerelease.join('.'))

  if (!validateStream(stream)) {
    return invalid
  }

  return stream
}

const parseStreamFromTag = tagName => {
  return parseStreamFromSemver(tagName, null)
}

const parseStreamFromVersion = version => {
  return parseStreamFromSemver(version, productionStream)
}

const resolveStream = ({queryStream, version}) => {
  if (validateStream(queryStream)) {
    return queryStream
  }

  return parseStreamFromVersion(version)
}

module.exports = {
  parseStreamFromTag,
  parseStreamFromVersion,
  resolveStream,
  validateStream
}
