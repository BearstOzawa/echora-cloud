import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import worker from '../src/index'
import { passwordIterations } from '../src/auth'
import { matchesBootstrapAdmin } from '../src/adminAuth'
import type { ReleaseManifest, WorkerEnv } from '../src/types'
import { cleanupMusicProviderHealth, orderMusicProvidersByHealth, readMusicProviderHealth, recordMusicProviderHealth } from '../src/musicHealth'
import { issueMusicPlaybackToken } from '../src/musicPlaybackToken'

const release: ReleaseManifest = {
  schemaVersion: 1,
  version: '0.2.0',
  minimumVersion: '0.1.0',
  releaseUrl: 'https://github.example/echora/releases/tag/v0.2.0',
  publishedAt: '2026-07-20T10:00:00Z',
  releaseNotes: '更新说明',
  actions: { web: { type: 'web-refresh', url: 'https://echora.example/' } },
}

const env = {
  RELEASES: {
    get: async (key: string) => key === 'version:published:echora-web:stable' ? release : null,
  },
  ALLOWED_ORIGIN: '*',
} as unknown as WorkerEnv

const dataEncryptionKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const playbackTokenFor = async (
  tokenEnv: WorkerEnv,
  deviceId: string,
  providerId: 'tx' | 'wy' | 'kw' | 'kg' | 'mg',
  requestedQuality: '128k' | '320k' | 'flac' | 'flac24bit',
  resolvedQuality: '128k' | '320k' | 'flac' | 'flac24bit',
) => issueMusicPlaybackToken(new Request('https://cloud.example/v1/music/resolve', {
  headers: { 'X-Echora-Device': deviceId },
}), tokenEnv, { providerId, requestedQuality, resolvedQuality })

afterEach(() => vi.restoreAllMocks())

const createTestDatabase = () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(new URL('../migrations/0001_cloud_core.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../migrations/0002_unique_device_sessions.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../migrations/0003_user_status.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../migrations/0004_independent_admin_auth.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../migrations/0005_version_registry.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../migrations/0006_music_provider_health.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../migrations/0007_music_playback_health.sql', import.meta.url), 'utf8'))

  const prepare = (query: string) => {
    let values: SQLInputValue[] = []
    const statement = {
      bind: (...nextValues: SQLInputValue[]) => {
        values = nextValues
        return statement
      },
      first: async <T>() => sqlite.prepare(query).get(...values) as T | null,
      all: async <T>() => ({ results: sqlite.prepare(query).all(...values) as T[] }),
      run: async () => sqlite.prepare(query).run(...values),
    }
    return statement
  }

  return {
    prepare,
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map((statement) => statement.run())),
    close: () => sqlite.close(),
  }
}

const loginAdmin = async (accountEnv: WorkerEnv) => {
  const response = await worker.fetch(new Request('https://cloud.example/v1/admin/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'a-strong-password' }),
  }), accountEnv)
  const cookie = response.headers.get('Set-Cookie')?.split(';')[0] || ''
  return { response, cookie }
}

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

  it('does not query GitHub when a published snapshot is missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }))
    const githubEnv = {
      ...env,
      GITHUB_REPOSITORY: 'echora/app',
      RELEASES: { get: async () => null },
    } as unknown as WorkerEnv
    const response = await worker.fetch(new Request('https://updates.example/v1/check?platform=web&current=0.1.0&channel=stable&installationId=browser-1'), githubEnv)
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'release channel has not been published' })
    expect(fetchMock).not.toHaveBeenCalled()
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
    await expect(response.json()).resolves.toMatchObject({
      version: '0.2.0',
      channel: 'stable',
      releaseUrl: 'https://github.example/echora/releases/tag/v0.2.0',
      downloads: [{ target: 'web', type: 'web-refresh' }],
    })
  })

  it('streams an authenticated GitHub draft asset without exposing the token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 42,
        name: 'Echora-0.2.0-macOS-arm64.dmg',
        url: 'https://api.github.test/assets/42',
        browser_download_url: 'https://github.test/draft.dmg',
        size: 4,
      }), { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://objects.github.test/signed-asset' } }))
      .mockResolvedValueOnce(new Response('dmg!', { status: 206, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '4', 'Content-Range': 'bytes 0-3/42', 'Accept-Ranges': 'bytes' } }))
    const downloadEnv = { ...env, GITHUB_REPOSITORY: 'echora/app', GITHUB_TOKEN: 'private-token' } as unknown as WorkerEnv

    const response = await worker.fetch(new Request('https://cloud.example/v1/releases/assets/42/Echora-0.2.0-macOS-arm64.dmg', { headers: { Range: 'bytes=0-3' } }), downloadEnv)

    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 0-3/42')
    expect(response.headers.get('Content-Disposition')).toContain('Echora-0.2.0-macOS-arm64.dmg')
    await expect(response.text()).resolves.toBe('dmg!')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const authorization = ((fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Headers).get('Authorization')
    expect(authorization).toBe('Bearer private-token')
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toEqual({ Range: 'bytes=0-3' })
    expect(response.headers.get('Authorization')).toBeNull()
  })

  it('redirects the retired iOS help route to downloads', async () => {
    const response = await worker.fetch(new Request('https://updates.example/help/install/ios'), env)
    expect(response.status).toBe(308)
    expect(response.headers.get('Location')).toBe('https://updates.example/download')
  })
})

describe('product capability boundaries', () => {
  it('keeps password derivation within the Cloudflare Workers PBKDF2 limit', () => {
    expect(passwordIterations({} as WorkerEnv)).toBe(100_000)
    expect(passwordIterations({ AUTH_PBKDF2_ITERATIONS: '210000' } as WorkerEnv)).toBe(100_000)
    expect(passwordIterations({ AUTH_PBKDF2_ITERATIONS: 'invalid' } as WorkerEnv)).toBe(100_000)
  })

  it('registers when an existing environment still requests 210000 PBKDF2 iterations', async () => {
    const database = createTestDatabase()
    const accountEnv = { ...env, DB: database, AUTH_PBKDF2_ITERATIONS: '210000' } as unknown as WorkerEnv

    try {
      const response = await worker.fetch(new Request('https://cloud.example/v1/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'pbkdf2_user', password: 'initial-password' }),
      }), accountEnv)
      expect(response.status).toBe(201)

      const user = await database.prepare('SELECT password_iterations, recovery_iterations FROM users WHERE username = ?')
        .bind('pbkdf2_user').first<{ password_iterations: number; recovery_iterations: number }>()
      expect(user).toEqual({ password_iterations: 100_000, recovery_iterations: 100_000 })
    } finally {
      database.close()
    }
  })

  it('requires and validates Turnstile for registration when configured', async () => {
    const database = createTestDatabase()
    const accountEnv = { ...env, DB: database, TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret-key' } as unknown as WorkerEnv
    const request = (turnstileToken?: string) => worker.fetch(new Request('https://cloud.example/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'verified_user', password: 'initial-password', turnstileToken }),
    }), accountEnv)

    try {
      const challenge = await request()
      expect(challenge.status).toBe(403)
      await expect(challenge.json()).resolves.toMatchObject({ error: 'challenge_required', challenge: { provider: 'turnstile', siteKey: 'site-key', action: 'register' } })

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, action: 'register', hostname: 'cloud.example' }), { headers: { 'Content-Type': 'application/json' } }))
      const registration = await request('verified-token')
      expect(registration.status).toBe(201)
    } finally {
      database.close()
    }
  })

  it('escalates repeated login failures to a Turnstile challenge', async () => {
    const database = createTestDatabase()
    const baseEnv = { ...env, DB: database } as unknown as WorkerEnv
    const securedEnv = { ...baseEnv, TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret-key' } as unknown as WorkerEnv
    const headers = { 'Content-Type': 'application/json', 'X-Echora-Device': 'risk-device', 'CF-Connecting-IP': '203.0.113.8' }

    try {
      await worker.fetch(new Request('https://cloud.example/v1/auth/register', { method: 'POST', headers, body: JSON.stringify({ username: 'risk_user', password: 'correct-password' }) }), baseEnv)
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const failed = await worker.fetch(new Request('https://cloud.example/v1/auth/login', { method: 'POST', headers, body: JSON.stringify({ username: 'risk_user', password: 'wrong-password' }) }), securedEnv)
        expect(failed.status).toBe(401)
      }
      const challenged = await worker.fetch(new Request('https://cloud.example/v1/auth/login', { method: 'POST', headers, body: JSON.stringify({ username: 'risk_user', password: 'correct-password' }) }), securedEnv)
      expect(challenged.status).toBe(403)
      await expect(challenged.json()).resolves.toMatchObject({ error: 'challenge_required', challenge: { action: 'login' } })

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, action: 'login', hostname: 'cloud.example' }), { headers: { 'Content-Type': 'application/json' } }))
      const accepted = await worker.fetch(new Request('https://cloud.example/v1/auth/login', { method: 'POST', headers, body: JSON.stringify({ username: 'risk_user', password: 'correct-password', turnstileToken: 'verified-token' }) }), securedEnv)
      expect(accepted.status).toBe(200)
    } finally {
      database.close()
    }
  })

  it('uses both bootstrap credentials for the initial administrator', () => {
    const bootstrapEnv = { ADMIN_BOOTSTRAP_USERNAME: 'Owner', ADMIN_BOOTSTRAP_PASSWORD: 'a-strong-password' } as WorkerEnv
    expect(matchesBootstrapAdmin(bootstrapEnv, 'owner', 'a-strong-password')).toBe(true)
    expect(matchesBootstrapAdmin(bootstrapEnv, 'owner', 'wrong-password')).toBe(false)
    expect(matchesBootstrapAdmin(bootstrapEnv, 'someone-else', 'a-strong-password')).toBe(false)
  })

  it('creates the initial administrator from the configured bootstrap credentials', async () => {
    const database = createTestDatabase()
    const accountEnv = {
      ...env,
      DB: database,
      ADMIN_BOOTSTRAP_USERNAME: 'owner',
      ADMIN_BOOTSTRAP_PASSWORD: 'a-strong-password',
    } as unknown as WorkerEnv

    try {
      const { response: login, cookie } = await loginAdmin(accountEnv)
      expect(login.status).toBe(200)
      await expect(login.json()).resolves.toMatchObject({ admin: { username: 'owner', displayName: 'Echora 管理员' } })
      expect(cookie).toContain('echora_admin_session=')

      const adminConfig = await worker.fetch(new Request('https://cloud.example/v1/admin/config', {
        headers: { Cookie: cookie },
      }), accountEnv)
      expect(adminConfig.status).toBe(200)

      const overview = await worker.fetch(new Request('https://cloud.example/v1/admin/overview', {
        headers: { Cookie: cookie },
      }), accountEnv)
      expect(overview.status).toBe(200)
      await expect(overview.json()).resolves.toMatchObject({
        admin: { username: 'owner' },
        users: {
          total: 0,
          activeSessions: 0,
          suspended: 0,
          pendingDeletion: 0,
          new7d: 0,
        },
        music: { enabledProviders: 5, totalProviders: 5, resolverConfigured: false },
        ai: { echoraEnabled: true, echoraConfigured: false, customEnabled: true, customConfiguredUsers: 0 },
      })

      const counts = await database.prepare(`SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM admin_accounts) AS admins`).first<{ users: number; admins: number }>()
      expect(counts).toEqual({ users: 0, admins: 1 })
    } finally {
      database.close()
    }
  })

  it('imports releases as drafts and only serves an explicitly published product snapshot', async () => {
    const database = createTestDatabase()
    const records = new Map<string, string>()
    const accountEnv = {
      ...env,
      DB: database,
      RELEASES: {
        get: async (key: string, type?: string) => {
          const value = records.get(key)
          return value && type === 'json' ? JSON.parse(value) : value ?? null
        },
        put: async (key: string, value: string) => { records.set(key, value) },
        delete: async (key: string) => { records.delete(key) },
      },
      GITHUB_REPOSITORY: 'echora/app',
      ADMIN_BOOTSTRAP_USERNAME: 'owner',
      ADMIN_BOOTSTRAP_PASSWORD: 'a-strong-password',
    } as unknown as WorkerEnv
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([{
      tag_name: 'v0.2.0',
      html_url: 'https://github.test/echora/app/releases/tag/v0.2.0',
      name: 'Echora 0.2.0',
      body: '稳定性与播放体验改进',
      draft: false,
      prerelease: false,
      published_at: '2026-07-20T10:00:00Z',
      created_at: '2026-07-20T09:00:00Z',
      assets: [
        { id: 1, name: 'Echora_0.2.0_aarch64.dmg', url: 'https://api.github.test/assets/1', browser_download_url: 'https://github.test/Echora.dmg', size: 42 },
        { id: 2, name: 'Echora_0.2.0_universal.apk', url: 'https://api.github.test/assets/2', browser_download_url: 'https://github.test/Echora.apk', size: 43 },
      ],
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    try {
      const { cookie } = await loginAdmin(accountEnv)
      const adminHeaders = { 'Content-Type': 'application/json', Cookie: cookie }
      const sync = await worker.fetch(new Request('https://cloud.example/v1/admin/versions/github-sync', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ channel: 'stable' }) }), accountEnv)
      expect(sync.status).toBe(200)
      await expect(sync.json()).resolves.toMatchObject({ status: 'success', releases: 2, version: '0.2.0' })

      const registry = await worker.fetch(new Request('https://cloud.example/v1/admin/versions', { headers: { Cookie: cookie } }), accountEnv)
      const registryPayload = await registry.json<{ releases: Array<{ id: string; product: string; status: string }> }>()
      const desktop = registryPayload.releases.find((item) => item.product === 'echora-desktop')
      expect(desktop).toMatchObject({ status: 'draft' })

      const beforePublish = await worker.fetch(new Request('https://cloud.example/v1/check?product=echora-desktop&platform=desktop&os=darwin&arch=aarch64&current=0.1.0'), accountEnv)
      expect(beforePublish.status).toBe(503)

      const publish = await worker.fetch(new Request(`https://cloud.example/v1/admin/versions/releases/${encodeURIComponent(desktop!.id)}`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ action: 'publish' }) }), accountEnv)
      expect(publish.status).toBe(200)
      expect(records.has('version:published:echora-desktop:stable')).toBe(true)

      const available = await worker.fetch(new Request('https://cloud.example/v1/check?product=echora-desktop&platform=desktop&os=darwin&arch=aarch64&current=0.1.0'), accountEnv)
      expect(available.status).toBe(200)
      await expect(available.json()).resolves.toMatchObject({ latestVersion: '0.2.0', updateAvailable: true })

      records.delete('version:published:echora-desktop:stable')
      const databaseFallback = await worker.fetch(new Request('https://cloud.example/v1/check?product=echora-desktop&platform=desktop&os=darwin&arch=aarch64&current=0.1.0'), accountEnv)
      expect(databaseFallback.status).toBe(200)

      const pause = await worker.fetch(new Request(`https://cloud.example/v1/admin/versions/releases/${encodeURIComponent(desktop!.id)}`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ action: 'pause' }) }), accountEnv)
      expect(pause.status).toBe(200)
      const afterPause = await worker.fetch(new Request('https://cloud.example/v1/check?product=echora-desktop&platform=desktop&os=darwin&arch=aarch64&current=0.1.0'), accountEnv)
      expect(afterPause.status).toBe(503)
    } finally {
      database.close()
    }
  })

  it('accepts signed deployment records and rejects unsigned ingestion', async () => {
    const database = createTestDatabase()
    const secret = 'deployment-secret'
    const deploymentEnv = { ...env, DB: database, INTERNAL_INGESTION_SECRET: secret } as unknown as WorkerEnv
    const body = JSON.stringify({ product: 'echora-web', environment: 'production', version: '0.2.0', buildId: 'web-20260726', url: 'https://echora-web.lili.uno', status: 'healthy' })
    const timestamp = String(Date.now())
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`))
    const signature = [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')

    try {
      const unsigned = await worker.fetch(new Request('https://cloud.example/v1/internal/deployments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), deploymentEnv)
      expect(unsigned.status).toBe(401)

      const accepted = await worker.fetch(new Request('https://cloud.example/v1/internal/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Echora-Timestamp': timestamp, 'X-Echora-Signature': signature },
        body,
      }), deploymentEnv)
      expect(accepted.status).toBe(202)
      const versions = await worker.fetch(new Request('https://cloud.example/v1/products/versions'), deploymentEnv)
      await expect(versions.json()).resolves.toMatchObject({ products: expect.arrayContaining([expect.objectContaining({ key: 'echora-web', deployment: expect.objectContaining({ version: '0.2.0', buildId: 'web-20260726', status: 'healthy' }) })]) })
    } finally {
      database.close()
    }
  })

  it('lets an administrator update encrypted service credentials', async () => {
    const database = createTestDatabase()
    const records = new Map<string, string>()
    const accountEnv = {
      ...env,
      DB: database,
      RELEASES: {
        get: async (key: string, type?: string) => {
          const value = records.get(key)
          return value && type === 'json' ? JSON.parse(value) : value ?? null
        },
        put: async (key: string, value: string) => { records.set(key, value) },
      },
      DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ADMIN_BOOTSTRAP_USERNAME: 'owner',
      ADMIN_BOOTSTRAP_PASSWORD: 'a-strong-password',
    } as unknown as WorkerEnv

    try {
      const { cookie } = await loginAdmin(accountEnv)
      const updated = await worker.fetch(new Request('https://cloud.example/v1/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ credentials: { musicResolverKey: 'music-key', aiProvider: 'compatible', aiBaseUrl: 'https://ai.example/v1', aiModel: 'echora-model', aiApiKey: 'ai-key', turnstileSiteKey: 'site-key', turnstileSecretKey: 'turnstile-secret' } }),
      }), accountEnv)
      expect(updated.status).toBe(200)
      await expect(updated.json()).resolves.toMatchObject({ credentials: { music: { configured: true }, ai: { configured: true, provider: 'compatible', model: 'echora-model' }, turnstile: { configured: true, siteKey: 'site-key' } } })
      expect(records.get('system:credentials:v1')).not.toContain('music-key')
      expect(records.get('system:credentials:v1')).not.toContain('ai-key')
      expect(records.get('system:credentials:v1')).not.toContain('turnstile-secret')

      const aiStatus = await worker.fetch(new Request('https://cloud.example/v1/ai/status'), accountEnv)
      await expect(aiStatus.json()).resolves.toEqual({ echoraAi: { available: true } })
    } finally {
      database.close()
    }
  })

  it('lets an administrator disable, restore and revoke a user account', async () => {
    const database = createTestDatabase()
    const accountEnv = {
      ...env,
      DB: database,
      ADMIN_BOOTSTRAP_USERNAME: 'owner',
      ADMIN_BOOTSTRAP_PASSWORD: 'a-strong-password',
    } as unknown as WorkerEnv
    const jsonHeaders = { 'Content-Type': 'application/json' }

    try {
      const { cookie } = await loginAdmin(accountEnv)
      const registration = await worker.fetch(new Request('https://cloud.example/v1/auth/register', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ username: 'listener', password: 'listener-password', displayName: 'Listener' }) }), accountEnv)
      const listener = await registration.json<{ user: { id: string } }>()
      const adminHeaders = { ...jsonHeaders, Cookie: cookie }

      const disabled = await worker.fetch(new Request(`https://cloud.example/v1/admin/users/${listener.user.id}`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ action: 'disable' }) }), accountEnv)
      expect(disabled.status).toBe(200)
      const rejected = await worker.fetch(new Request('https://cloud.example/v1/auth/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ username: 'listener', password: 'listener-password' }) }), accountEnv)
      expect(rejected.status).toBe(403)

      const enabled = await worker.fetch(new Request(`https://cloud.example/v1/admin/users/${listener.user.id}`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ action: 'enable' }) }), accountEnv)
      expect(enabled.status).toBe(200)
      const accepted = await worker.fetch(new Request('https://cloud.example/v1/auth/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ username: 'listener', password: 'listener-password' }) }), accountEnv)
      expect(accepted.status).toBe(200)

      const users = await worker.fetch(new Request('https://cloud.example/v1/admin/users?sort=active_desc&page=1&pageSize=25', { headers: { Cookie: cookie } }), accountEnv)
      expect(users.status).toBe(200)
      await expect(users.json()).resolves.toMatchObject({
        users: [{ id: listener.user.id, username: 'listener', deviceCount: 1, contentCount: 0, customAiConfigured: false }],
        pagination: { page: 1, pageSize: 25, total: 1, pages: 1 },
      })

      await database.prepare('UPDATE users SET deletion_requested_at = ?, deletion_due_at = ? WHERE id = ?').bind(Date.now(), Date.now() + 86_400_000, listener.user.id).run()
      const cancelled = await worker.fetch(new Request(`https://cloud.example/v1/admin/users/${listener.user.id}`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ action: 'cancel_deletion' }) }), accountEnv)
      expect(cancelled.status).toBe(200)
      await expect(cancelled.json()).resolves.toMatchObject({ user: { id: listener.user.id, deletionDueAt: null } })
    } finally {
      database.close()
    }
  })

  it('requires an account before changing a password', async () => {
    const response = await worker.fetch(new Request('https://cloud.example/v1/me/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'current-password', newPassword: 'next-password' }),
    }), env)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'authentication_required' })
  })

  it('keeps one device entry when the same installation signs in again', async () => {
    const database = createTestDatabase()
    const accountEnv = { ...env, DB: database } as unknown as WorkerEnv
    const headers = {
      'Content-Type': 'application/json',
      'X-Echora-Device': 'installation-1',
      'X-Echora-Device-Name': 'Echora Desktop',
    }

    try {
      const registration = await worker.fetch(new Request('https://cloud.example/v1/auth/register', {
        method: 'POST',
        headers,
        body: JSON.stringify({ username: 'listener', password: 'initial-password', displayName: 'Listener' }),
      }), accountEnv)
      expect(registration.status).toBe(201)
      const initial = await registration.json<{ token: string }>()

      const login = await worker.fetch(new Request('https://cloud.example/v1/auth/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ username: 'listener', password: 'initial-password' }),
      }), accountEnv)
      expect(login.status).toBe(200)
      const current = await login.json<{ token: string }>()
      expect(current.token).not.toBe(initial.token)

      const devices = await worker.fetch(new Request('https://cloud.example/v1/me/devices', {
        headers: { Authorization: `Bearer ${current.token}` },
      }), accountEnv)
      expect(devices.status).toBe(200)
      await expect(devices.json()).resolves.toMatchObject({
        devices: [{ deviceId: 'installation-1', name: 'Echora Desktop', current: true }],
      })

      const replacedSession = await worker.fetch(new Request('https://cloud.example/v1/me', {
        headers: { Authorization: `Bearer ${initial.token}` },
      }), accountEnv)
      expect(replacedSession.status).toBe(401)
    } finally {
      database.close()
    }
  })

  it('accepts mature account snapshots larger than the former 128 KB limit', async () => {
    const database = createTestDatabase()
    const accountEnv = { ...env, DB: database } as unknown as WorkerEnv
    const headers = {
      'Content-Type': 'application/json',
      'X-Echora-Device': 'large-account-snapshot',
      'X-Echora-Device-Name': 'Echora Desktop',
    }

    try {
      const registration = await worker.fetch(new Request('https://cloud.example/v1/auth/register', {
        method: 'POST',
        headers,
        body: JSON.stringify({ username: 'large_snapshot', password: 'initial-password', displayName: 'Large Snapshot' }),
      }), accountEnv)
      const session = await registration.json<{ token: string }>()
      const response = await worker.fetch(new Request('https://cloud.example/v1/sync', {
        method: 'POST',
        headers: { ...headers, Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ operations: [{ operationId: 'snapshot-1', collection: 'conversations', entityId: 'main', payload: { text: 'x'.repeat(160 * 1024) } }] }),
      }), accountEnv)
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ accepted: [{ operationId: 'snapshot-1' }] })
    } finally {
      database.close()
    }
  })

  it('keeps bounded provider health aggregates without storing request details', async () => {
    const database = createTestDatabase()
    const accountEnv = { ...env, DB: database } as unknown as WorkerEnv
    try {
      await recordMusicProviderHealth(accountEnv, { providerId: 'tx', operation: 'resolve', outcome: 'success', latencyMs: 600, downgraded: true })
      await recordMusicProviderHealth(accountEnv, { providerId: 'tx', operation: 'resolve', outcome: 'delegated', latencyMs: 900 })
      await recordMusicProviderHealth(accountEnv, { providerId: 'tx', operation: 'resolve', outcome: 'error', latencyMs: 1_500, error: new Error('failed at https://resolver.example/path?key=secret') })

      const [provider] = await readMusicProviderHealth(accountEnv, 7)
      expect(provider).toMatchObject({
        providerId: 'tx',
        requestCount: 3,
        successCount: 1,
        errorCount: 1,
        delegatedCount: 1,
        averageLatencyMs: 1000,
        downgradeCount: 1,
        successRate: .5,
      })
      expect(provider.lastError?.message).toContain('上游服务')
      expect(provider.lastError?.message).not.toContain('resolver.example')

      const rows = await database.prepare('SELECT COUNT(*) AS total FROM music_provider_health_daily').first<{ total: number }>()
      expect(rows?.total).toBe(1)
    } finally {
      database.close()
    }
  })

  it('accepts privacy-bounded final playback events and aggregates quality downgrade', async () => {
    const database = createTestDatabase()
    const accountEnv = { ...env, DB: database, DATA_ENCRYPTION_KEY: dataEncryptionKey } as unknown as WorkerEnv
    try {
      const missingDevice = await worker.fetch(new Request('https://cloud.example/v1/music/playback-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [{ source: 'tx', outcome: 'success', latencyMs: 320, requestedQuality: 'flac', resolvedQuality: '320k' }] }),
      }), accountEnv)
      expect(missingDevice.status).toBe(400)

      const token = await playbackTokenFor(accountEnv, 'web-device', 'tx', 'flac', '320k')

      const response = await worker.fetch(new Request('https://cloud.example/v1/music/playback-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Echora-Device': 'web-device' },
        body: JSON.stringify({ events: [
          { source: 'tx', outcome: 'success', latencyMs: 320, requestedQuality: 'flac', resolvedQuality: '320k', playbackToken: token },
          { source: 'tx', outcome: 'error', latencyMs: 8_400, reason: 'stalled', requestedQuality: 'flac', resolvedQuality: '320k', playbackToken: token },
        ] }),
      }), accountEnv)
      expect(response.status).toBe(202)
      await expect(response.json()).resolves.toEqual({ accepted: 2, ignored: 0 })

      const provider = (await readMusicProviderHealth(accountEnv, 7)).find((item) => item.providerId === 'tx')!
      expect(provider.operations.playback).toMatchObject({
        requestCount: 2,
        successCount: 1,
        errorCount: 1,
        averageLatencyMs: 4360,
        downgradeCount: 2,
      })
      expect(provider.lastError).toMatchObject({ code: 'stalled', message: '播放未能持续进行' })
    } finally {
      database.close()
    }
  })

  it('rejects missing, tampered, device-bound, and mismatched playback tokens', async () => {
    const database = createTestDatabase()
    const accountEnv = { ...env, DB: database, DATA_ENCRYPTION_KEY: dataEncryptionKey } as unknown as WorkerEnv
    const token = (await playbackTokenFor(accountEnv, 'web-device', 'wy', 'flac', '320k'))!
    const [payload, signature] = token.split('.')
    const tamperedToken = `${payload}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`
    const baseEvent = { source: 'wy', outcome: 'success', latencyMs: 120, requestedQuality: 'flac', resolvedQuality: '320k' }
    const cases = [
      { device: 'web-device', event: baseEvent },
      { device: 'web-device', event: { ...baseEvent, playbackToken: tamperedToken } },
      { device: 'another-device', event: { ...baseEvent, playbackToken: token } },
      { device: 'web-device', event: { ...baseEvent, source: 'tx', playbackToken: token } },
      { device: 'web-device', event: { ...baseEvent, resolvedQuality: '128k', playbackToken: token } },
    ]
    try {
      for (const testCase of cases) {
        const response = await worker.fetch(new Request('https://cloud.example/v1/music/playback-events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Echora-Device': testCase.device },
          body: JSON.stringify({ events: [testCase.event] }),
        }), accountEnv)
        expect(response.status).toBe(403)
        await expect(response.json()).resolves.toMatchObject({ error: 'invalid_playback_token' })
      }
      const rows = await database.prepare('SELECT COUNT(*) AS total FROM music_provider_health_daily').first<{ total: number }>()
      expect(rows?.total).toBe(0)
    } finally {
      database.close()
    }
  })

  it('suppresses duplicate outcomes while accepting a later distinct outcome', async () => {
    const database = createTestDatabase()
    const records = new Map<string, string>()
    const accountEnv = {
      ...env,
      DB: database,
      DATA_ENCRYPTION_KEY: dataEncryptionKey,
      CONFIG: {
        get: async (key: string) => records.get(key) ?? null,
        put: async (key: string, value: string) => { records.set(key, value) },
      },
    } as unknown as WorkerEnv
    const token = await playbackTokenFor(accountEnv, 'web-device', 'kg', '320k', '128k')
    const report = (outcome: 'success' | 'error') => worker.fetch(new Request('https://cloud.example/v1/music/playback-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Echora-Device': 'web-device' },
      body: JSON.stringify({ events: [{
        source: 'kg', outcome, latencyMs: outcome === 'success' ? 240 : 1_200,
        requestedQuality: '320k', resolvedQuality: '128k', playbackToken: token,
        ...(outcome === 'error' ? { reason: 'stalled' } : {}),
      }] }),
    }), accountEnv)
    try {
      const first = await report('success')
      await expect(first.json()).resolves.toEqual({ accepted: 1, ignored: 0 })
      const duplicate = await report('success')
      await expect(duplicate.json()).resolves.toEqual({ accepted: 0, ignored: 1 })
      const laterFailure = await report('error')
      await expect(laterFailure.json()).resolves.toEqual({ accepted: 1, ignored: 0 })

      const provider = (await readMusicProviderHealth(accountEnv, 7)).find((item) => item.providerId === 'kg')!
      expect(provider.operations.playback).toMatchObject({ requestCount: 2, successCount: 1, errorCount: 1 })
      expect([...records.keys()].filter((key) => key.startsWith('music:playback-health:'))).toHaveLength(2)
    } finally {
      database.close()
    }
  })

  it('rate limits playback reports before persistence', async () => {
    const database = createTestDatabase()
    const accountEnv = {
      ...env,
      DB: database,
      DATA_ENCRYPTION_KEY: dataEncryptionKey,
      AUTH_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
    } as unknown as WorkerEnv
    const token = await playbackTokenFor(accountEnv, 'web-device', 'mg', '128k', '128k')
    try {
      const response = await worker.fetch(new Request('https://cloud.example/v1/music/playback-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Echora-Device': 'web-device' },
        body: JSON.stringify({ events: [{ source: 'mg', outcome: 'success', latencyMs: 120, requestedQuality: '128k', resolvedQuality: '128k', playbackToken: token }] }),
      }), accountEnv)
      expect(response.status).toBe(429)
      const rows = await database.prepare('SELECT COUNT(*) AS total FROM music_provider_health_daily').first<{ total: number }>()
      expect(rows?.total).toBe(0)
    } finally {
      database.close()
    }
  })

  it('rejects playback identity and media fields instead of storing them', async () => {
    const database = createTestDatabase()
    const accountEnv = { ...env, DB: database, DATA_ENCRYPTION_KEY: dataEncryptionKey } as unknown as WorkerEnv
    const token = await playbackTokenFor(accountEnv, 'web-device', 'wy', '128k', '128k')
    try {
      for (const body of [
        { events: [{ source: 'wy', outcome: 'success', latencyMs: 120, requestedQuality: '128k', resolvedQuality: '128k', playbackToken: token, songId: 'private-id' }] },
        { events: [{ source: 'wy', outcome: 'success', latencyMs: 120, requestedQuality: '128k', resolvedQuality: '128k', playbackToken: token }], userId: 'private-user' },
      ]) {
        const response = await worker.fetch(new Request('https://cloud.example/v1/music/playback-events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Echora-Device': 'web-device' },
          body: JSON.stringify(body),
        }), accountEnv)
        expect(response.status).toBe(400)
      }
      const rows = await database.prepare('SELECT COUNT(*) AS total FROM music_provider_health_daily').first<{ total: number }>()
      expect(rows?.total).toBe(0)
    } finally {
      database.close()
    }
  })

  it('keeps playback event ingestion available when D1 persistence fails', async () => {
    const failingEnv = {
      ...env,
      DATA_ENCRYPTION_KEY: dataEncryptionKey,
      DB: { prepare: () => { throw new Error('D1 unavailable') } },
    } as unknown as WorkerEnv
    const token = await playbackTokenFor(failingEnv, 'web-device', 'kg', '128k', '128k')
    const response = await worker.fetch(new Request('https://cloud.example/v1/music/playback-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Echora-Device': 'web-device' },
      body: JSON.stringify({ events: [{ source: 'kg', outcome: 'error', latencyMs: 900, reason: 'network', requestedQuality: '128k', resolvedQuality: '128k', playbackToken: token }] }),
    }), failingEnv)
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ accepted: 1, ignored: 0 })
  })

  it('temporarily moves a repeatedly failing provider behind healthy configured peers', async () => {
    const database = createTestDatabase()
    const accountEnv = { ...env, DB: database } as unknown as WorkerEnv
    try {
      for (let sample = 0; sample < 5; sample += 1) {
        await recordMusicProviderHealth(accountEnv, { providerId: 'tx', operation: 'search', outcome: 'error', latencyMs: 500, error: new Error('unavailable') })
        await recordMusicProviderHealth(accountEnv, { providerId: 'wy', operation: 'search', outcome: 'success', latencyMs: 300 })
      }
      await expect(orderMusicProvidersByHealth(accountEnv, 'search', ['tx', 'wy', 'kg'])).resolves.toEqual(['wy', 'kg', 'tx'])
    } finally {
      database.close()
    }
  })

  it('uses repeated final playback failures for temporary provider ordering', async () => {
    const database = createTestDatabase()
    const accountEnv = { ...env, DB: database } as unknown as WorkerEnv
    try {
      for (let sample = 0; sample < 5; sample += 1) {
        await recordMusicProviderHealth(accountEnv, { providerId: 'tx', operation: 'playback', outcome: 'error', latencyMs: 700, error: new Error('media failed') })
      }
      await expect(orderMusicProvidersByHealth(accountEnv, 'chart', ['tx', 'wy', 'kg'])).resolves.toEqual(['wy', 'kg', 'tx'])
    } finally {
      database.close()
    }
  })

  it('limits provider health access to administrators and returns empty providers in configured order', async () => {
    const database = createTestDatabase()
    const accountEnv = {
      ...env,
      DB: database,
      ADMIN_BOOTSTRAP_USERNAME: 'owner',
      ADMIN_BOOTSTRAP_PASSWORD: 'a-strong-password',
    } as unknown as WorkerEnv
    try {
      const unauthorized = await worker.fetch(new Request('https://cloud.example/v1/admin/music/health'), accountEnv)
      expect(unauthorized.status).toBe(401)

      const { cookie } = await loginAdmin(accountEnv)
      const response = await worker.fetch(new Request('https://cloud.example/v1/admin/music/health?days=30', { headers: { Cookie: cookie } }), accountEnv)
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        days: 30,
        providers: [
          { id: 'tx', priority: 1, requestCount: 0, successRate: null, state: 'unknown', operations: { playback: { requestCount: 0 } } },
          { id: 'wy', priority: 2 },
          { id: 'kw', priority: 3 },
          { id: 'kg', priority: 4 },
          { id: 'mg', priority: 5 },
        ],
      })
    } finally {
      database.close()
    }
  })

  it('preserves existing provider aggregates when adding playback health', () => {
    const database = new DatabaseSync(':memory:')
    try {
      database.exec(readFileSync(new URL('../migrations/0006_music_provider_health.sql', import.meta.url), 'utf8'))
      database.prepare(`INSERT INTO music_provider_health_daily (
        day, provider_id, operation, request_count, success_count, error_count, delegated_count,
        latency_total_ms, downgrade_count, last_error_code, last_error_message, last_error_at, updated_at
      ) VALUES ('2026-07-27', 'wy', 'search', 3, 2, 1, 0, 900, 0, 'upstream', '暂时不可用', 1, 1)`).run()
      database.exec(readFileSync(new URL('../migrations/0007_music_playback_health.sql', import.meta.url), 'utf8'))

      expect(database.prepare('SELECT provider_id, operation, request_count FROM music_provider_health_daily').get())
        .toEqual({ provider_id: 'wy', operation: 'search', request_count: 3 })
      expect(() => database.prepare(`INSERT INTO music_provider_health_daily (day, provider_id, operation, updated_at) VALUES ('2026-07-27', 'wy', 'playback', 1)`).run()).not.toThrow()
    } finally {
      database.close()
    }
  })

  it('removes provider health outside retention while keeping recent aggregates', async () => {
    const database = createTestDatabase()
    const accountEnv = { ...env, DB: database } as unknown as WorkerEnv
    try {
      await recordMusicProviderHealth(accountEnv, { providerId: 'tx', operation: 'search', outcome: 'success', latencyMs: 100, occurredAt: Date.now() - 32 * 86_400_000 })
      await recordMusicProviderHealth(accountEnv, { providerId: 'wy', operation: 'search', outcome: 'success', latencyMs: 100 })
      await cleanupMusicProviderHealth(accountEnv, 30)
      const rows = await database.prepare('SELECT provider_id FROM music_provider_health_daily ORDER BY provider_id').all<{ provider_id: string }>()
      expect(rows.results).toEqual([{ provider_id: 'wy' }])
    } finally {
      database.close()
    }
  })

  it('keeps music responses available when health persistence fails', async () => {
    const failingEnv = {
      ...env,
      DB: { prepare: () => { throw new Error('D1 unavailable') } },
    } as unknown as WorkerEnv
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { song: { list: [
      { mid: 'tx-1', name: 'Song', singer: [{ name: 'Artist' }], album: { name: 'Album', mid: 'album-1' }, interval: 180, file: { media_mid: 'media-1', size_128mp3: 1 } },
    ] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const response = await worker.fetch(new Request('https://cloud.example/v1/music/search?query=test&sources=tx&limit=1'), failingEnv)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ tracks: [{ source: 'tx', title: 'Song' }] })
  })

  it('exposes online music status without requiring an account', async () => {
    const response = await worker.fetch(new Request('https://cloud.example/v1/music/status'), env)
    expect(response.status).toBe(200)
    const payload = await response.json<Record<string, unknown>>()
    expect(payload).toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ source: 'tx', enabled: true, availability: 'limited' }),
        expect.objectContaining({ source: 'wy', enabled: true, availability: 'enabled' }),
        expect.objectContaining({ source: 'mg', enabled: true, availability: 'limited' }),
      ]),
      qualities: ['128k', '320k', 'flac', 'flac24bit'],
    })
    expect(payload).not.toHaveProperty('sourceVersion')
  })

  it('interleaves search results in the configured provider order', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('y.qq.com')) return new Response(JSON.stringify({ data: { song: { list: [
        { mid: 'tx-1', name: 'QQ One', singer: [{ name: 'QQ Artist 1' }], album: { name: 'QQ Album 1', mid: 'album-1' }, interval: 180, file: { media_mid: 'media-1', size_128mp3: 1 } },
        { mid: 'tx-2', name: 'QQ Two', singer: [{ name: 'QQ Artist 2' }], album: { name: 'QQ Album 2', mid: 'album-2' }, interval: 181, file: { media_mid: 'media-2', size_128mp3: 1 } },
      ] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('music.163.com')) return new Response(JSON.stringify({ result: { songs: [
        { id: 'wy-1', name: 'WY One', artists: [{ name: 'WY Artist 1' }], album: { name: 'WY Album 1' }, duration: 182000 },
        { id: 'wy-2', name: 'WY Two', artists: [{ name: 'WY Artist 2' }], album: { name: 'WY Album 2' }, duration: 183000 },
      ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('{}', { status: 404 })
    })

    const response = await worker.fetch(new Request('https://cloud.example/v1/music/search?query=test&sources=tx,wy&limit=2'), env)
    const payload = await response.json<{ tracks: Array<{ source: string }> }>()

    expect(response.status).toBe(200)
    expect(payload.tracks.map((track) => track.source)).toEqual(['tx', 'wy', 'tx', 'wy'])
  })

  it('uses official Netease charts when Cloudflare search egress returns no songs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/search/get/web')) return new Response(JSON.stringify({ result: { songs: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/api/playlist/detail')) return new Response(JSON.stringify({ result: { tracks: [
        { id: 'wy-fallback', name: '晴天', artists: [{ name: '周杰伦' }], album: { name: '叶惠美', picUrl: 'https://image.example/cover.jpg' }, duration: 269000, lMusic: { size: 3_000_000 }, hMusic: { size: 8_000_000 } },
        { id: 'wy-other', name: '其他歌曲', artists: [{ name: '其他艺人' }], album: { name: '其他专辑' }, duration: 180000, lMusic: { size: 3_000_000 } },
      ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('{}', { status: 404 })
    })

    const response = await worker.fetch(new Request('https://cloud.example/v1/music/search?query=周杰伦&sources=wy&limit=3'), env)
    const payload = await response.json<{ tracks: Array<{ source: string; title: string; qualities: string[] }> }>()

    expect(response.status).toBe(200)
    expect(payload.tracks).toEqual([expect.objectContaining({ source: 'wy', title: '晴天', qualities: ['128k', '320k'] })])
  })

  it('uses the supported Kugou catalog origin for chart details', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('m.kugou.com')) return new Response(JSON.stringify({ url: 'https://media.example/playable.mp3', timeLength: 180 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({
        data: {
          rankinfo: { rankname: 'TOP500' },
          info: [{
            hash: 'base-hash',
            songname: 'Playable Song',
            singername: 'Singer',
            duration: 180,
            filesize: 3_000_000,
            audio_id: 'audio-1',
            pay_type: 0,
            price: 0,
          }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const response = await worker.fetch(new Request('https://cloud.example/v1/music/charts/kg/8888?limit=1'), env)
    const payload = await response.json<{ chart: { tracks: Array<{ title: string; qualities: string[] }> } }>()

    expect(response.status).toBe(200)
    expect(payload.chart.tracks).toHaveLength(1)
    expect(payload.chart.tracks[0].title).toBe('Playable Song')
    expect(payload.chart.tracks[0].qualities).toEqual(['128k'])
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/mobilecdnbj\.kugou\.com\//), expect.any(Object))
  })

  it('filters paid Kugou catalog entries while retaining free and limited-free tracks', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      const entries = [
        { FileHash: 'paid-hash', hash: 'paid-hash', SongName: 'Paid Song', songname: 'Paid Song', SingerName: 'Singer', singername: 'Singer', Duration: 180, duration: 180, FileSize: 3_000_000, filesize: 3_000_000, PayType: 3, pay_type: 3, Price: 200, price: 200 },
        { FileHash: 'limited-hash', hash: 'limited-hash', SongName: 'Limited Song', songname: 'Limited Song', SingerName: 'Singer', singername: 'Singer', Duration: 181, duration: 181, FileSize: 3_000_000, filesize: 3_000_000, PayType: 3, pay_type: 3, Price: 200, price: 200, trans_param: { free_limited: 1 } },
        { FileHash: 'free-hash', hash: 'free-hash', SongName: 'Free Song', songname: 'Free Song', SingerName: 'Singer', singername: 'Singer', Duration: 182, duration: 182, FileSize: 3_000_000, filesize: 3_000_000, PayType: 0, pay_type: 0, Price: 0, price: 0 },
      ]
      if (url.includes('song_search_v2')) return new Response(JSON.stringify({ data: { lists: entries } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('m.kugou.com')) return new Response(JSON.stringify({ url: 'https://media.example/playable.mp3', timeLength: 181 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ data: { rankinfo: { rankname: 'TOP500' }, info: entries } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const search = await worker.fetch(new Request('https://cloud.example/v1/music/search?query=test&sources=kg&limit=10'), env)
    const searchPayload = await search.json<{ tracks: Array<{ title: string }> }>()
    const chart = await worker.fetch(new Request('https://cloud.example/v1/music/charts/kg/8888?limit=10'), env)
    const chartPayload = await chart.json<{ chart: { tracks: Array<{ title: string }> } }>()

    expect(searchPayload.tracks.map((track) => track.title)).toEqual(['Limited Song', 'Free Song'])
    expect(chartPayload.chart.tracks.map((track) => track.title)).toEqual(['Limited Song', 'Free Song'])
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('getSongInfo.php'))).toHaveLength(0)
  })

  it('probes Kugou entries when catalog rights are missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('song_search_v2')) return new Response(JSON.stringify({ data: { lists: [
        { FileHash: 'blocked-hash', SongName: 'Blocked Song', SingerName: 'Singer', Duration: 180, FileSize: 3_000_000 },
        { FileHash: 'playable-hash', SongName: 'Playable Song', SingerName: 'Singer', Duration: 181, FileSize: 3_000_000 },
      ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.toLocaleLowerCase().includes('blocked-hash')) return new Response(JSON.stringify({ error: '需要付费', url: '', timeLength: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ error: '', url: 'https://media.example/playable.mp3', timeLength: 181 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const response = await worker.fetch(new Request('https://cloud.example/v1/music/search?query=test&sources=kg&limit=10'), env)
    const payload = await response.json<{ tracks: Array<{ title: string }> }>()

    expect(response.status).toBe(200)
    expect(payload.tracks.map((track) => track.title)).toEqual(['Playable Song'])
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('m.kugou.com/app/i/getSongInfo.php'), expect.any(Object))
  })

  it('publishes resolvable Migu chart entries without rejecting normal copyright flags', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: {
        columnInfo: {
          columnTitle: '尖叫热歌榜',
          contents: [
            { objectInfo: { songId: 'incomplete', copyrightId: 'incomplete-rights', songName: 'Incomplete Song', copyrightType: '0', scopeOfcopyright: '00' } },
            { objectInfo: { songId: 'playable', copyrightId: 'normal-rights', contentId: 'content-1', songName: 'Playable Song', copyrightType: '1', restrictType: '1', scopeOfcopyright: '01', rateFormats: [{ formatType: 'PQ', size: 3_000_000 }, { formatType: 'HQ', size: 8_000_000 }] } },
          ],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const response = await worker.fetch(new Request('https://cloud.example/v1/music/charts/mg/27186466?limit=10'), env)
    const payload = await response.json<{ chart: { tracks: Array<{ title: string; qualities: string[] }> } }>()

    expect(response.status).toBe(200)
    expect(payload.chart.tracks.map((track) => track.title)).toEqual(['Playable Song'])
    expect(payload.chart.tracks[0].qualities).toEqual(['128k', '320k'])
  })

  it('keeps normal Migu search results and filters entries that cannot be resolved', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      songResultData: {
        resultList: [[
          { songId: 'incomplete', copyrightId: 'incomplete-rights', name: 'Incomplete Song', copyrightType: '0', audioFormats: [{ formatType: 'PQ', asize: 3_000_000 }] },
          { songId: 'playable', copyrightId: 'normal-rights', contentId: 'content-1', name: 'Playable Song', copyrightType: '1', restrictType: '1', audioFormats: [{ formatType: 'PQ', asize: 3_000_000 }, { formatType: 'SQ', asize: 18_000_000 }] },
        ]],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const response = await worker.fetch(new Request('https://cloud.example/v1/music/search?query=test&sources=mg&limit=10'), env)
    const payload = await response.json<{ tracks: Array<{ title: string; qualities: string[] }> }>()

    expect(response.status).toBe(200)
    expect(payload.tracks.map((track) => track.title)).toEqual(['Playable Song'])
    expect(payload.tracks[0].qualities).toEqual(['128k', 'flac'])
  })

  it('uses Kugou playback metadata and reports the quality actually returned', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      url: 'http://fsandroid.tx.kugou.com/path/song.mp3',
      bitRate: 128,
      extName: 'mp3',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const response = await worker.fetch(new Request('https://cloud.example/v1/music/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Echora-Device': 'web-device' },
      body: JSON.stringify({
        source: 'kg',
        quality: '320k',
        musicInfo: { songmid: 'song-id', hash: 'song-hash', _types: { '320k': { hash: 'hq-hash' } } },
      }),
    }), { ...env, DATA_ENCRYPTION_KEY: dataEncryptionKey } as WorkerEnv)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      url: 'https://fsandroid.tx.kugou.com/path/song.mp3',
      source: 'kg',
      resolvedQuality: '128k',
      playbackToken: expect.any(String),
    })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('m.kugou.com/app/i/getSongInfo.php'), expect.any(Object))
  })

  it('retries Kugou playback metadata through its HTTP origin when HTTPS returns no URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      return new Response(JSON.stringify(url.startsWith('http://') ? {
        url: 'http://fsandroid.tx.kugou.com/path/fallback.mp3',
        bitRate: 128,
        extName: 'mp3',
      } : {
        status: 1,
        errcode: 0,
        url: '',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const response = await worker.fetch(new Request('https://cloud.example/v1/music/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kg', quality: '128k', musicInfo: { songmid: 'song-id', hash: 'song-hash' } }),
    }), env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      url: 'https://fsandroid.tx.kugou.com/path/fallback.mp3',
      source: 'kg',
      resolvedQuality: '128k',
    })
    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringMatching(/^https:\/\/m\.kugou\.com\//), expect.any(Object))
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringMatching(/^http:\/\/m\.kugou\.com\//), expect.any(Object))
  })

  it('lets the client resolve Kugou when Cloudflare egress returns no playback URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 1, errcode: 0, url: '' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const response = await worker.fetch(new Request('https://cloud.example/v1/music/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kg', quality: '128k', musicInfo: { songmid: 'song-id', hash: 'song-hash' } }),
    }), env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      source: 'kg',
      resolvedQuality: '128k',
      directResolver: {
        provider: 'kugou',
        url: expect.stringMatching(/^https:\/\/m\.kugou\.com\/app\/i\/getSongInfo\.php/),
      },
    })
  })

  it('extracts nested Kuwo media URLs and keeps their cache lifetime conservative', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      data: { url: 'http://car-er.kuwo.cn/path/song.mp3' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const before = Date.now()
    const response = await worker.fetch(new Request('https://cloud.example/v1/music/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kw', quality: '320k', musicInfo: { songmid: '228908' } }),
    }), env)
    const payload = await response.json<{ url: string; expiresAt: number }>()

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('nmobi.kuwo.cn/mobi.s'), expect.any(Object))
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('br=320kmp3'), expect.any(Object))
    expect(payload.url).toBe('https://car-er.kuwo.cn/path/song.mp3')
    expect(payload.expiresAt).toBeGreaterThan(before + 2 * 60_000)
    expect(payload.expiresAt).toBeLessThanOrEqual(before + 3 * 60_000 + 1000)
  })

  it('rejects a Kuwo short announcement instead of treating it as a full song', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, url: 'https://nf-sycdn.kuwo.cn/announcement.mp3' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '181521' } }))

    const response = await worker.fetch(new Request('https://cloud.example/v1/music/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kw', quality: '128k', musicInfo: { songmid: '228908', interval: '04:29' } }),
    }), env)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ error: 'playback_preview_only' })
  })

  it('lets the client resolve Kuwo when Cloudflare egress is region restricted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 403, message: 'This resource is not available in your region or country due to copyright protection' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const response = await worker.fetch(new Request('https://cloud.example/v1/music/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kw', quality: '320k', musicInfo: { songmid: '567247828' } }),
    }), env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      source: 'kw',
      resolvedQuality: '320k',
      directResolver: { provider: 'kuwo', url: expect.stringContaining('nmobi.kuwo.cn/mobi.s') },
    })
  })

  it('lets the client resolve Kuwo when the Cloudflare upstream request times out', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('upstream timeout'))
    const response = await worker.fetch(new Request('https://cloud.example/v1/music/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kw', quality: '128k', musicInfo: { songmid: '567247828' } }),
    }), env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      source: 'kw',
      directResolver: { provider: 'kuwo', url: expect.stringContaining('nmobi.kuwo.cn/mobi.s') },
    })
  })

  it('sends Migu resolver identity headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { url: 'https://media.example.com/song.mp3' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const response = await worker.fetch(new Request('https://cloud.example/v1/music/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'mg', quality: '128k', musicInfo: { songmid: '6868', contentId: '600902000006889294', copyrightId: '60054701941' } }),
    }), env)

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/MIGUM3.0/strategy/pc/listen/v1.0'), expect.objectContaining({
      headers: expect.objectContaining({ channel: '0146951', uid: '1234' }),
    }))
  })

  it('lets the client resolve QQ when the provider rejects Cloudflare egress', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ message: 'edge rejected' }), { status: 456, headers: { 'Content-Type': 'application/json' } }))
    const response = await worker.fetch(new Request('https://cloud.example/v1/music/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'tx', quality: '128k', musicInfo: { songmid: '0039MnYb0qxYhV' } }),
    }), { ...env, ECHORA_MUSIC_RESOLVER_KEY: 'resolver-key' } as WorkerEnv)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      source: 'tx',
      resolvedQuality: '128k',
      directResolver: { provider: 'qq', url: expect.stringContaining('api-v2.yuafeng.cn/API/qqmusic.php') },
    })
  })

  it('maps resolver upstream failures to a diagnosable 502 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ message: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } }))
    const response = await worker.fetch(new Request('https://cloud.example/v1/music/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kg', quality: '128k', musicInfo: { songmid: 'hash', hash: 'hash' } }),
    }), env)

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({ error: 'music_upstream_error', upstreamStatus: 403 })
  })

  it('requires an Echora account before forwarding managed AI requests', async () => {
    const response = await worker.fetch(new Request('https://cloud.example/v1/ai/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '生成一份歌单' }] }),
    }), env)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'authentication_required' })
  })

  it('forwards custom AI with the encrypted account credential', async () => {
    const database = createTestDatabase()
    const accountEnv = {
      ...env,
      DB: database,
      DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    } as unknown as WorkerEnv
    const headers = { 'Content-Type': 'application/json', 'X-Echora-Device': 'web-device' }

    try {
      const registration = await worker.fetch(new Request('https://cloud.example/v1/auth/register', {
        method: 'POST',
        headers,
        body: JSON.stringify({ username: 'web_listener', password: 'initial-password' }),
      }), accountEnv)
      const session = await registration.json<{ token: string }>()
      const authorizedHeaders = { ...headers, Authorization: `Bearer ${session.token}` }
      const saved = await worker.fetch(new Request('https://cloud.example/v1/me/credentials/custom-ai', {
        method: 'PUT',
        headers: authorizedHeaders,
        body: JSON.stringify({ credential: { provider: 'compatible', baseUrl: 'https://ai.example/v1', model: 'account-model', apiKey: 'account-key' } }),
      }), accountEnv)
      expect(saved.status).toBe(200)

      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 }))
      const response = await worker.fetch(new Request('https://cloud.example/v1/ai/custom/request', {
        method: 'POST',
        headers: authorizedHeaders,
        body: JSON.stringify({
          url: 'https://attacker.example/request',
          provider: 'openai',
          headers: { Authorization: 'Bearer attacker-key' },
          body: JSON.stringify({ model: 'client-model', messages: [{ role: 'user', content: '编排音乐' }] }),
        }),
      }), accountEnv)

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledOnce()
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://ai.example/v1/chat/completions')
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer account-key')
      expect(JSON.parse(String(init.body))).toMatchObject({ model: 'account-model', messages: [{ role: 'user', content: '编排音乐' }] })
    } finally {
      database.close()
    }
  })

  it('returns CORS headers for API preflight requests', async () => {
    const response = await worker.fetch(new Request('https://cloud.example/v1/sync', {
      method: 'OPTIONS',
      headers: { Origin: 'https://echora.example' },
    }), env)
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('DELETE')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
  })
})
