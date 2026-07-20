import { describe, expect, it } from 'vitest'
import { compareVersions, isVersion } from '../src/semver'

describe('semantic version comparison', () => {
  it('compares stable versions and ignores build metadata', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('v1.0.0+12', '1.0.0+11')).toBe(0)
  })

  it('orders prereleases before stable releases', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
  })

  it('rejects partial or arbitrary versions', () => {
    expect(isVersion('1.2')).toBe(false)
    expect(isVersion('latest')).toBe(false)
  })
})
