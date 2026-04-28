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

const parseStreamFromSemver = value => {
  const version = semver.valid(value)

  if (!version) {
    return productionStream
  }

  const parsed = semver.parse(version)

  if (!parsed || parsed.prerelease.length === 0) {
    return productionStream
  }

  const stream = normaliseStream(parsed.prerelease.join('.'))

  if (!validateStream(stream)) {
    return productionStream
  }

  return stream
}

const parseStreamFromTag = tagName => {
  return parseStreamFromSemver(tagName)
}

const parseStreamFromVersion = version => {
  return parseStreamFromSemver(version)
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
