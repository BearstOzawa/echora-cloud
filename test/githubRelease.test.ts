import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchGithubReleaseManifest } from '../src/githubRelease'
import type { WorkerEnv } from '../src/types'

afterEach(() => vi.restoreAllMocks())

describe('GitHub release source', () => {
  it('derives platform actions from the latest release assets', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      tag_name: 'v0.2.0',
      html_url: 'https://github.test/echora/app/releases/tag/v0.2.0',
      name: 'Echora 0.2.0',
      body: '本次更新说明',
      draft: false,
      prerelease: false,
      published_at: '2026-07-20T10:00:00Z',
      created_at: '2026-07-20T09:00:00Z',
      assets: [
        { id: 1, name: 'Echora_0.2.0_aarch64.dmg', url: 'https://api.github.test/assets/1', browser_download_url: 'https://github.test/Echora.dmg', size: 42, digest: `sha256:${'a'.repeat(64)}` },
        { id: 2, name: 'Echora_0.2.0_universal.apk', url: 'https://api.github.test/assets/2', browser_download_url: 'https://github.test/Echora.apk', size: 43, digest: null },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const manifest = await fetchGithubReleaseManifest({
      GITHUB_REPOSITORY: 'echora/app',
      R2_DOWNLOAD_BASE_URL: 'https://releases.echora.test',
    }, 'stable')
    expect(manifest).toMatchObject({
      version: '0.2.0',
      minimumVersion: '0.0.0',
      releaseNotes: '本次更新说明',
      releaseUrl: 'https://github.test/echora/app/releases/tag/v0.2.0',
    })
    expect(manifest.actions['desktop:darwin:aarch64']).toMatchObject({
      type: 'github-release',
      url: 'https://releases.echora.test/v0.2.0/Echora_0.2.0_aarch64.dmg',
      fallbackUrl: 'https://github.test/Echora.dmg',
      sha256: 'a'.repeat(64),
    })
    expect(manifest.actions['mobile:android:universal']?.type).toBe('apk-download')
    expect(manifest.actions.web).toBeUndefined()
    expect(request).toHaveBeenCalledWith('https://api.github.com/repos/echora/app/releases/latest', expect.anything())
  })

  it('allows an authenticated admin import to select the newest draft release', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([
      {
        tag_name: 'v0.3.0', html_url: 'https://github.test/releases/v0.3.0', name: 'Echora 0.3.0', body: '',
        draft: true, prerelease: false, published_at: null, created_at: '2026-07-22T10:00:00Z',
        assets: [{ id: 3, name: 'Echora-0.3.0-macOS-arm64.dmg', url: 'https://api.github.test/assets/3', browser_download_url: 'https://github.test/Echora.dmg', size: 44 }],
      },
      {
        tag_name: 'v0.2.0', html_url: 'https://github.test/releases/v0.2.0', name: 'Echora 0.2.0', body: '',
        draft: false, prerelease: false, published_at: '2026-07-20T10:00:00Z', created_at: '2026-07-20T09:00:00Z', assets: [],
      },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const manifest = await fetchGithubReleaseManifest({ GITHUB_REPOSITORY: 'echora/app', GITHUB_TOKEN: 'test-token', PUBLIC_CLOUD_URL: 'https://cloud.example' }, 'stable', { includeDrafts: true })

    expect(manifest.version).toBe('0.3.0')
    expect(manifest.releaseUrl).toBeUndefined()
    expect(manifest.actions['desktop:darwin:aarch64']).toMatchObject({
      url: 'https://cloud.example/v1/releases/assets/3/Echora-0.3.0-macOS-arm64.dmg',
    })
    expect(manifest.actions['desktop:darwin:aarch64']?.fallbackUrl).toBeUndefined()
    expect(request).toHaveBeenCalledWith('https://api.github.com/repos/echora/app/releases?per_page=30', expect.objectContaining({
      headers: expect.objectContaining({}),
    }))
    const headers = (request.mock.calls[0]?.[1] as RequestInit).headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer test-token')
  })

  it('explains why a draft cannot be imported without GitHub credentials', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(fetchGithubReleaseManifest({ GITHUB_REPOSITORY: 'echora/app' }, 'stable', { includeDrafts: true }))
      .rejects.toThrow('如果目标版本仍是 GitHub 草稿')
  })
})
