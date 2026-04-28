/* global describe, it, expect */
const {
  parseStreamFromTag,
  parseStreamFromVersion,
  resolveStream,
  validateStream
} = require('../lib/streams')

describe('Streams', () => {
  it('parses production from tags without a prerelease suffix', () => {
    expect(parseStreamFromTag('v1.2.3')).toBe('production')
    expect(parseStreamFromTag('1.2.3')).toBe('production')
  })

  it('parses production from explicit production tags', () => {
    expect(parseStreamFromTag('v1.2.3-production')).toBe('production')
  })

  it('parses stream names from release tags', () => {
    expect(parseStreamFromTag('v1.2.3-uat')).toBe('uat')
    expect(parseStreamFromTag('v1.2.3-whitelabel-sv')).toBe('whitelabel-sv')
  })

  it('parses stream names from client versions', () => {
    expect(parseStreamFromVersion('1.2.3')).toBe('production')
    expect(parseStreamFromVersion('1.2.3-uat')).toBe('uat')
    expect(parseStreamFromVersion('1.2.3-whitelabel-sv')).toBe(
      'whitelabel-sv'
    )
  })

  it('does not treat build metadata as a stream', () => {
    expect(parseStreamFromVersion('1.2.3+uat')).toBe('production')
  })

  it('falls back to production for invalid prerelease streams', () => {
    expect(parseStreamFromVersion('1.2.3-beta.1')).toBe('production')
  })

  it('validates stream query values', () => {
    expect(validateStream('uat')).toBe(true)
    expect(validateStream('whitelabel-sv')).toBe(true)
    expect(validateStream('qa_1')).toBe(true)
    expect(validateStream('bad stream')).toBe(false)
    expect(validateStream('../production')).toBe(false)
  })

  it('resolves query stream before version stream', () => {
    expect(resolveStream({queryStream: 'production', version: '1.2.3-uat'}))
      .toBe('production')
  })

  it('ignores invalid query streams when resolving', () => {
    expect(resolveStream({queryStream: '../production', version: '1.2.3-uat'}))
      .toBe('uat')
  })

  it('resolves version stream when query stream is absent', () => {
    expect(resolveStream({version: '1.2.3-uat'})).toBe('uat')
  })

  it('defaults to production without query or version stream', () => {
    expect(resolveStream({version: '1.2.3'})).toBe('production')
  })
})
