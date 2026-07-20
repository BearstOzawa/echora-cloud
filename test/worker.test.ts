import { describe, expect, it } from 'vitest'
import worker from '../src/index'
import type { ReleaseManifest, WorkerEnv } from '../src/types'

const release: ReleaseManifest = {
  schemaVersion: 1,
  version: '0.2.0',
  minimumVersion: '0.1.0',
  publishedAt: '2026-07-20T10:00:00Z',
  releaseNotes: '更新说明',
  actions: { web: { type: 'web-refresh', url: 'https://echora.example/' } },
}

const env = {
  RELEASES: {
    get: async (key: string) => key === 'release:stable' ? release : null,
  },
  ALLOWED_ORIGIN: '*',
} as unknown as WorkerEnv

describe('update worker', () => {
  it('returns a normalized update response', async () => {
    const response = await worker.fetch(new Request('https://updates.example/v1/check?platform=web&os=browser&arch=universal&current=0.1.0&channel=stable&installationId=browser-1'), env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ latestVersion: '0.2.0', updateAvailable: true, action: { type: 'web-refresh' } })
  })

  it('reports unpublished channels without pretending the app is current', async () => {
    const response = await worker.fetch(new Request('https://updates.example/v1/check?platform=web&current=0.1.0&channel=beta&installationId=browser-1'), env)
    expect(response.status).toBe(503)
  })

  it('does not offer a Tauri downgrade', async () => {
    const tauriRelease = { ...release, actions: { 'tauri:darwin-aarch64': { type: 'tauri-update' as const, url: 'https://github.example/echora.tar.gz', signature: 'signed', tauriTarget: 'darwin-aarch64' } } }
    const tauriEnv = { ...env, RELEASES: { get: async () => tauriRelease } } as unknown as WorkerEnv
    const response = await worker.fetch(new Request('https://updates.example/v1/tauri/stable/darwin-aarch64?current=0.3.0'), tauriEnv)
    expect(response.status).toBe(204)
  })

  it('serves a release catalog for the official website', async () => {
    const response = await worker.fetch(new Request('https://updates.example/v1/releases/latest'), env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ version: '0.2.0', channel: 'stable', downloads: [{ target: 'web', type: 'web-refresh' }] })
  })
})
