import { describe, expect, it } from 'vitest'
import { checkRelease, isRolloutEligible } from '../src/release'
import type { ReleaseManifest } from '../src/types'

const manifest: ReleaseManifest = {
  schemaVersion: 1,
  version: '0.2.0',
  minimumVersion: '0.1.5',
  buildId: 'web-200',
  publishedAt: '2026-07-20T10:00:00Z',
  releaseNotes: '测试更新',
  actions: {
    web: { type: 'web-refresh', url: 'https://echora.example/' },
    'desktop:darwin:aarch64': { type: 'tauri-update', url: 'https://github.example/echora.tar.gz', signature: 'signed' },
  },
}

describe('release policy', () => {
  it('selects a precise platform action', () => {
    const result = checkRelease(manifest, { platform: 'desktop', os: 'darwin', arch: 'aarch64', currentVersion: '0.1.0', currentBuildId: null, channel: 'stable', installationId: 'device-a' })
    expect(result.updateAvailable).toBe(true)
    expect(result.mandatory).toBe(true)
    expect(result.action?.type).toBe('tauri-update')
  })

  it('supports same-version Web rebuilds', () => {
    const result = checkRelease(manifest, { platform: 'web', os: 'browser', arch: 'universal', currentVersion: '0.2.0', currentBuildId: 'web-199', channel: 'stable', installationId: 'browser-a' })
    expect(result.updateAvailable).toBe(true)
    expect(result.action?.type).toBe('web-refresh')
  })

  it('does not invent an action for unsupported targets', () => {
    const result = checkRelease(manifest, { platform: 'desktop', os: 'linux', arch: 'riscv64', currentVersion: '0.1.0', currentBuildId: null, channel: 'stable', installationId: 'device-b' })
    expect(result.updateAvailable).toBe(false)
    expect(result.action).toBeNull()
  })

  it('keeps rollout assignment deterministic', () => {
    const partial = { ...manifest, rollout: { percentage: 35, salt: 'release-020' } }
    expect(isRolloutEligible(partial, 'install-42')).toBe(isRolloutEligible(partial, 'install-42'))
  })
})
