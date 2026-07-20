import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchGithubReleaseManifest } from '../src/githubRelease'
import type { WorkerEnv } from '../src/types'

afterEach(() => vi.restoreAllMocks())

describe('GitHub release source', () => {
  it('derives platform actions from the latest release assets', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      tag_name: 'v0.2.0',
      name: 'Echora 0.2.0',
      body: '本次更新说明',
      draft: false,
      prerelease: false,
      published_at: '2026-07-20T10:00:00Z',
      created_at: '2026-07-20T09:00:00Z',
      assets: [
        { name: 'Echora_0.2.0_aarch64.dmg', url: 'https://api.github.test/assets/1', browser_download_url: 'https://github.test/Echora.dmg', size: 42, digest: `sha256:${'a'.repeat(64)}` },
        { name: 'Echora_0.2.0_universal.apk', url: 'https://api.github.test/assets/2', browser_download_url: 'https://github.test/Echora.apk', size: 43, digest: null },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const manifest = await fetchGithubReleaseManifest({
      GITHUB_REPOSITORY: 'echora/app',
      R2_DOWNLOAD_BASE_URL: 'https://releases.echora.test',
      WEB_APP_URL: 'https://echora.test/app',
    }, 'stable')
    expect(manifest).toMatchObject({ version: '0.2.0', minimumVersion: '0.0.0', releaseNotes: '本次更新说明' })
    expect(manifest.actions['desktop:darwin:aarch64']).toMatchObject({
      type: 'github-release',
      url: 'https://releases.echora.test/v0.2.0/Echora_0.2.0_aarch64.dmg',
      fallbackUrl: 'https://github.test/Echora.dmg',
      sha256: 'a'.repeat(64),
    })
    expect(manifest.actions['mobile:android:universal']?.type).toBe('apk-download')
    expect(manifest.actions.web).toEqual({ type: 'web-refresh', url: 'https://echora.test/app' })
  })
})
