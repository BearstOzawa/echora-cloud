import { authenticateAdmin } from './adminAuth'
import { fetchGithubReleaseManifest } from './githubRelease'
import { HttpError, json, readJson } from './http'
import { isVersion } from './semver'
import type { ReleaseAction, ReleaseManifest, VersionProductKey, VersionReleaseStatus, WorkerEnv } from './types'

const productKeys = ['echora-web', 'echora-cloud', 'echora-desktop', 'echora-android', 'echora-ios'] as const
const releaseStatuses = new Set<VersionReleaseStatus>(['draft', 'pending', 'published', 'paused', 'withdrawn'])
const safeChannel = /^[a-z0-9._-]{1,32}$/

type ReleaseRow = {
  id: string
  product_key: VersionProductKey
  channel: string
  version: string
  build_id: string | null
  status: VersionReleaseStatus
  minimum_version: string
  rollout_percentage: number
  rollout_salt: string
  release_notes: string
  source: string
  source_ref: string | null
  source_url: string | null
  created_at: number
  updated_at: number
  published_at: number | null
}

type ArtifactRow = {
  release_id: string
  target: string
  action_type: ReleaseAction['type']
  url: string
  fallback_url: string | null
  label: string | null
  signature: string | null
  sha256: string | null
  size: number | null
  tauri_target: string | null
}

const database = (env: WorkerEnv) => {
  if (!env.DB) throw new HttpError(503, '版本服务尚未完成配置', 'version_database_unavailable')
  return env.DB
}

const publishedKey = (product: VersionProductKey, channel: string) => `version:published:${product}:${channel}`

export const productForRequest = (platform: string, os: string): VersionProductKey => {
  if (platform === 'web') return 'echora-web'
  if (platform === 'desktop') return 'echora-desktop'
  if (os === 'android') return 'echora-android'
  if (os === 'ios') return 'echora-ios'
  return 'echora-desktop'
}

export const parseProduct = (value: string | null | undefined, fallback?: VersionProductKey) => {
  const product = (value?.trim() || fallback || '') as VersionProductKey
  if (!productKeys.includes(product)) throw new HttpError(400, '产品标识无效', 'invalid_product')
  return product
}

const manifestFromRows = (release: ReleaseRow, artifacts: ArtifactRow[]): ReleaseManifest => ({
  schemaVersion: 1,
  version: release.version,
  minimumVersion: release.minimum_version,
  ...(release.source_url ? { releaseUrl: release.source_url } : {}),
  ...(release.build_id ? { buildId: release.build_id } : {}),
  publishedAt: new Date(release.published_at || release.updated_at).toISOString(),
  releaseNotes: release.release_notes,
  rollout: { percentage: release.rollout_percentage, salt: release.rollout_salt },
  actions: Object.fromEntries(artifacts.map((artifact) => [artifact.target, {
    type: artifact.action_type,
    url: artifact.url,
    ...(artifact.fallback_url ? { fallbackUrl: artifact.fallback_url } : {}),
    ...(artifact.label ? { label: artifact.label } : {}),
    ...(artifact.signature ? { signature: artifact.signature } : {}),
    ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    ...(artifact.size ? { size: artifact.size } : {}),
    ...(artifact.tauri_target ? { tauriTarget: artifact.tauri_target } : {}),
  } satisfies ReleaseAction])),
})

const releaseWithArtifacts = async (env: WorkerEnv, release: ReleaseRow) => {
  const artifacts = await database(env).prepare('SELECT * FROM version_artifacts WHERE release_id = ? ORDER BY target').bind(release.id).all<ArtifactRow>()
  return manifestFromRows(release, artifacts.results)
}

export const loadPublishedRelease = async (env: WorkerEnv, product: VersionProductKey, channel: string) => {
  if (env.RELEASES) {
    const cached = await env.RELEASES.get<ReleaseManifest>(publishedKey(product, channel), 'json')
    if (cached) return cached
  }
  if (!env.DB) return null
  const release = await env.DB.prepare(`SELECT * FROM version_releases
    WHERE product_key = ? AND channel = ? AND status = 'published'
    ORDER BY published_at DESC, updated_at DESC LIMIT 1`).bind(product, channel).first<ReleaseRow>()
  return release ? releaseWithArtifacts(env, release) : null
}

const actionsForProduct = (manifest: ReleaseManifest, product: VersionProductKey) => Object.fromEntries(Object.entries(manifest.actions).filter(([target]) => {
  if (product === 'echora-web') return target === 'web'
  if (product === 'echora-desktop') return target.startsWith('desktop:') || target.startsWith('tauri:')
  if (product === 'echora-android') return target.startsWith('mobile:android')
  if (product === 'echora-ios') return target.startsWith('mobile:ios')
  return false
}))

const upsertImportedRelease = async (env: WorkerEnv, product: VersionProductKey, channel: string, manifest: ReleaseManifest) => {
  const actions = actionsForProduct(manifest, product)
  if (!Object.keys(actions).length) return null
  const db = database(env)
  const now = Date.now()
  const id = `${product}:${channel}:${manifest.version}:${manifest.buildId || 'default'}`
  const existing = await db.prepare('SELECT status, created_at, published_at FROM version_releases WHERE id = ?').bind(id).first<Pick<ReleaseRow, 'status' | 'created_at' | 'published_at'>>()
  const status = existing?.status || 'draft'
  const statements = [
    db.prepare(`INSERT INTO version_releases
      (id, product_key, channel, version, build_id, status, minimum_version, rollout_percentage, rollout_salt, release_notes, source, source_ref, source_url, created_at, updated_at, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'github', ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET minimum_version = excluded.minimum_version, release_notes = excluded.release_notes,
        source_ref = excluded.source_ref, source_url = excluded.source_url, updated_at = excluded.updated_at`)
      .bind(id, product, channel, manifest.version, manifest.buildId || null, status, manifest.minimumVersion,
        manifest.rollout?.percentage ?? 100, manifest.rollout?.salt || id, manifest.releaseNotes, manifest.buildId || manifest.version,
        manifest.releaseUrl || null, existing?.created_at || now, now, existing?.published_at || null),
    db.prepare('DELETE FROM version_artifacts WHERE release_id = ?').bind(id),
    ...Object.entries(actions).map(([target, action]) => db.prepare(`INSERT INTO version_artifacts
      (id, release_id, target, action_type, url, fallback_url, label, signature, sha256, size, tauri_target, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(`${id}:${target}`, id, target, action.type, action.url, action.fallbackUrl || null, action.label || null,
        action.signature || null, action.sha256 || null, action.size || null, action.tauriTarget || null, now, now)),
  ]
  await db.batch(statements)
  if (status === 'published' && env.RELEASES) {
    const row = await db.prepare('SELECT * FROM version_releases WHERE id = ?').bind(id).first<ReleaseRow>()
    if (row) await env.RELEASES.put(publishedKey(product, channel), JSON.stringify(await releaseWithArtifacts(env, row)))
  }
  return id
}

type GithubReconcileOptions = {
  includeDrafts?: boolean
}

export const reconcileGithubReleases = async (env: WorkerEnv, channels: string[] = ['stable', 'beta'], options: GithubReconcileOptions = {}) => {
  if (!env.DB || !env.GITHUB_REPOSITORY?.trim()) return []
  const results: Array<{ channel: string; status: 'success' | 'failed'; releases?: number; version?: string; error?: string }> = []
  for (const channel of channels) {
    try {
      const manifest = await fetchGithubReleaseManifest(env, channel, options)
      const imported = await Promise.all((['echora-desktop', 'echora-android', 'echora-ios'] as VersionProductKey[])
        .map((product) => upsertImportedRelease(env, product, channel, manifest)))
      const releases = imported.filter(Boolean).length
      results.push({ channel, status: 'success', releases, version: manifest.version })
      await env.DB.prepare('INSERT INTO version_sync_log (source, channel, status, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind('github', channel, 'success', JSON.stringify({ version: manifest.version, releases }), Date.now()).run()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GitHub synchronization failed'
      results.push({ channel, status: 'failed', error: message })
      await env.DB.prepare('INSERT INTO version_sync_log (source, channel, status, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind('github', channel, 'failed', JSON.stringify({ error: message }), Date.now()).run()
    }
  }
  return results
}

const publicRelease = (row: ReleaseRow, artifactCount = 0) => ({
  id: row.id,
  product: row.product_key,
  channel: row.channel,
  version: row.version,
  buildId: row.build_id,
  status: row.status,
  minimumVersion: row.minimum_version,
  rolloutPercentage: row.rollout_percentage,
  releaseNotes: row.release_notes,
  source: row.source,
  sourceUrl: row.source_url,
  publishedAt: row.published_at,
  updatedAt: row.updated_at,
  artifactCount,
})

export const publicProductVersions = async (request: Request, env: WorkerEnv) => {
  if (!env.DB) return json(request, env, { products: [] }, 200, { 'Cache-Control': 'public, max-age=60' })
  const result = await env.DB.prepare(`SELECT p.product_key, p.display_name, p.product_type,
      r.version, r.build_id, r.channel, r.published_at,
      d.version AS deployment_version, d.build_id AS deployment_build_id, d.status AS deployment_status,
      d.deployed_at, d.deployment_url
    FROM version_products p
    LEFT JOIN version_releases r ON r.id = (SELECT id FROM version_releases WHERE product_key = p.product_key AND status = 'published' ORDER BY published_at DESC LIMIT 1)
    LEFT JOIN version_deployments d ON d.id = (SELECT id FROM version_deployments WHERE product_key = p.product_key ORDER BY deployed_at DESC LIMIT 1)
    WHERE p.active = 1 ORDER BY p.sort_order`).all<any>()
  return json(request, env, { products: result.results.map((row) => ({
    key: row.product_key, name: row.display_name, type: row.product_type,
    release: row.version ? { version: row.version, buildId: row.build_id, channel: row.channel, publishedAt: row.published_at } : null,
    deployment: row.deployment_version ? { version: row.deployment_version, buildId: row.deployment_build_id, status: row.deployment_status, deployedAt: row.deployed_at, url: row.deployment_url } : null,
  })) }, 200, { 'Cache-Control': 'public, max-age=60' })
}

export const adminVersions = async (request: Request, env: WorkerEnv) => {
  await authenticateAdmin(request, env)
  const db = database(env)
  const [products, releases, deployments, sync] = await Promise.all([
    db.prepare('SELECT * FROM version_products ORDER BY sort_order').all<any>(),
    db.prepare(`SELECT r.*, COUNT(a.id) AS artifact_count FROM version_releases r
      LEFT JOIN version_artifacts a ON a.release_id = r.id GROUP BY r.id ORDER BY r.updated_at DESC LIMIT 100`).all<ReleaseRow & { artifact_count: number }>(),
    db.prepare('SELECT * FROM version_deployments ORDER BY deployed_at DESC LIMIT 50').all<any>(),
    db.prepare('SELECT * FROM version_sync_log ORDER BY created_at DESC LIMIT 10').all<any>(),
  ])
  return json(request, env, {
    products: products.results.map((row) => ({ key: row.product_key, name: row.display_name, type: row.product_type, active: Boolean(row.active) })),
    releases: releases.results.map((row) => publicRelease(row, Number(row.artifact_count || 0))),
    deployments: deployments.results.map((row) => ({ id: row.id, product: row.product_key, environment: row.environment, version: row.version, buildId: row.build_id, commit: row.commit_sha, url: row.deployment_url, status: row.status, deployedAt: row.deployed_at })),
    sync: sync.results.map((row) => ({ id: row.id, source: row.source, channel: row.channel, status: row.status, detail: row.detail_json ? JSON.parse(row.detail_json) : null, createdAt: row.created_at })),
  })
}

const audit = (env: WorkerEnv, adminId: string, action: string, target: string, detail: unknown) => database(env)
  .prepare('INSERT INTO admin_audit_log (actor_admin_id, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
  .bind(adminId, action, target, detail ? JSON.stringify(detail) : null, Date.now()).run()

export const adminGithubSync = async (request: Request, env: WorkerEnv) => {
  const context = await authenticateAdmin(request, env)
  const body = await readJson<{ channel?: unknown }>(request)
  const channel = typeof body.channel === 'string' ? body.channel.trim() : 'stable'
  if (!safeChannel.test(channel)) throw new HttpError(400, '发布通道无效', 'invalid_channel')
  const results = await reconcileGithubReleases(env, [channel], { includeDrafts: true })
  const result = results[0]
  if (!result || result.status === 'failed') throw new HttpError(502, result?.error || 'GitHub 发布同步失败', 'github_sync_failed')
  await audit(env, context.admin.id, 'version.github_sync', channel, result)
  return json(request, env, result)
}

export const adminReleaseAction = async (request: Request, env: WorkerEnv, releaseId: string) => {
  const context = await authenticateAdmin(request, env)
  const db = database(env)
  const release = await db.prepare('SELECT * FROM version_releases WHERE id = ?').bind(releaseId).first<ReleaseRow>()
  if (!release) throw new HttpError(404, '版本记录不存在', 'release_not_found')
  const body = await readJson<{ action?: unknown; minimumVersion?: unknown; rolloutPercentage?: unknown; releaseNotes?: unknown }>(request)
  const action = typeof body.action === 'string' ? body.action : ''
  const now = Date.now()
  if (action === 'update') {
    const minimumVersion = typeof body.minimumVersion === 'string' ? body.minimumVersion.trim() : release.minimum_version
    const rolloutPercentage = body.rolloutPercentage === undefined ? release.rollout_percentage : Number(body.rolloutPercentage)
    const releaseNotes = typeof body.releaseNotes === 'string' ? body.releaseNotes.trim().slice(0, 10_000) : release.release_notes
    if (!isVersion(minimumVersion)) throw new HttpError(400, '最低版本格式无效', 'invalid_minimum_version')
    if (!Number.isInteger(rolloutPercentage) || rolloutPercentage < 0 || rolloutPercentage > 100) throw new HttpError(400, '灰度比例需要为 0–100 的整数', 'invalid_rollout')
    await db.prepare('UPDATE version_releases SET minimum_version = ?, rollout_percentage = ?, release_notes = ?, updated_at = ? WHERE id = ?')
      .bind(minimumVersion, rolloutPercentage, releaseNotes, now, releaseId).run()
  } else if (action === 'publish') {
    const artifact = await db.prepare('SELECT id FROM version_artifacts WHERE release_id = ? LIMIT 1').bind(releaseId).first()
    if (!artifact && !['echora-web', 'echora-cloud'].includes(release.product_key)) throw new HttpError(400, '版本没有可用安装包', 'release_artifacts_missing')
    await db.batch([
      db.prepare(`UPDATE version_releases SET status = 'paused', updated_at = ? WHERE product_key = ? AND channel = ? AND status = 'published' AND id <> ?`).bind(now, release.product_key, release.channel, releaseId),
      db.prepare(`UPDATE version_releases SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, releaseId),
    ])
  } else if (action === 'pause' || action === 'withdraw') {
    const nextStatus: VersionReleaseStatus = action === 'pause' ? 'paused' : 'withdrawn'
    await db.prepare('UPDATE version_releases SET status = ?, updated_at = ? WHERE id = ?').bind(nextStatus, now, releaseId).run()
  } else if (action === 'pending') {
    await db.prepare(`UPDATE version_releases SET status = 'pending', updated_at = ? WHERE id = ?`).bind(now, releaseId).run()
  } else {
    throw new HttpError(400, '版本操作无效', 'invalid_release_action')
  }
  const updated = await db.prepare('SELECT * FROM version_releases WHERE id = ?').bind(releaseId).first<ReleaseRow>()
  if (!updated || !releaseStatuses.has(updated.status)) throw new HttpError(500, '版本状态更新失败', 'release_update_failed')
  if (env.RELEASES) {
    if (updated.status === 'published') await env.RELEASES.put(publishedKey(updated.product_key, updated.channel), JSON.stringify(await releaseWithArtifacts(env, updated)))
    else if (release.status === 'published') await env.RELEASES.delete(publishedKey(release.product_key, release.channel))
  }
  await audit(env, context.admin.id, `version.${action}`, releaseId, { product: release.product_key, channel: release.channel })
  return json(request, env, { release: publicRelease(updated) })
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
const safeEqual = (left: string, right: string) => left.length === right.length && [...left].reduce((equal, character, index) => equal & Number(character === right[index]), 1) === 1
const hmacHex = async (secret: string, value: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))
}

const verifyInternalSignature = async (request: Request, env: WorkerEnv, body: string) => {
  const secret = env.INTERNAL_INGESTION_SECRET?.trim()
  if (!secret) throw new HttpError(503, '内部发布入口尚未配置', 'ingestion_unavailable')
  const timestamp = request.headers.get('X-Echora-Timestamp') || ''
  const signature = (request.headers.get('X-Echora-Signature') || '').replace(/^sha256=/, '')
  const time = Number(timestamp)
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60_000) throw new HttpError(401, '发布签名已失效', 'invalid_ingestion_signature')
  const expected = await hmacHex(secret, `${timestamp}.${body}`)
  if (!safeEqual(expected, signature)) throw new HttpError(401, '发布签名无效', 'invalid_ingestion_signature')
}

export const githubReleaseWebhook = async (request: Request, env: WorkerEnv) => {
  const secret = env.GITHUB_WEBHOOK_SECRET?.trim()
  if (!secret) throw new HttpError(503, 'GitHub Webhook 尚未配置', 'github_webhook_unavailable')
  const text = await request.text()
  const signature = (request.headers.get('X-Hub-Signature-256') || '').replace(/^sha256=/, '')
  if (!safeEqual(await hmacHex(secret, text), signature)) throw new HttpError(401, 'Webhook 签名无效', 'invalid_webhook_signature')
  const event = request.headers.get('X-GitHub-Event')
  if (event === 'ping') return json(request, env, { accepted: true }, 202)
  if (event !== 'release') throw new HttpError(400, 'Webhook 事件不受支持', 'unsupported_webhook_event')
  let payload: any
  try { payload = JSON.parse(text || '{}') } catch { throw new HttpError(400, 'Webhook 内容无效', 'invalid_webhook_payload') }
  if (payload.repository?.full_name !== env.GITHUB_REPOSITORY) throw new HttpError(403, 'Webhook 仓库不匹配', 'webhook_repository_mismatch')
  if (!['published', 'released'].includes(payload.action)) return json(request, env, { accepted: true, skipped: true }, 202)
  const channel = payload.release?.prerelease ? 'beta' : 'stable'
  const result = (await reconcileGithubReleases(env, [channel]))[0]
  if (!result || result.status === 'failed') throw new HttpError(502, 'GitHub 发布同步失败', 'github_sync_failed', { detail: result?.error })
  return json(request, env, { accepted: true, ...result }, 202)
}

export const registerDeployment = async (request: Request, env: WorkerEnv) => {
  const text = await request.text()
  await verifyInternalSignature(request, env, text)
  let body: Record<string, unknown>
  try { body = JSON.parse(text || '{}') as Record<string, unknown> } catch { throw new HttpError(400, '部署信息无效', 'invalid_deployment') }
  const product = parseProduct(typeof body.product === 'string' ? body.product : '')
  const environment = typeof body.environment === 'string' ? body.environment.trim() : 'production'
  const version = typeof body.version === 'string' ? body.version.trim() : ''
  const buildId = typeof body.buildId === 'string' ? body.buildId.trim() : ''
  const status = typeof body.status === 'string' && ['healthy', 'degraded', 'failed', 'unknown'].includes(body.status) ? body.status : 'healthy'
  if (!safeChannel.test(environment) || !isVersion(version) || !buildId) throw new HttpError(400, '部署信息无效', 'invalid_deployment')
  const now = Date.now()
  const id = `${product}:${environment}:${buildId}`
  await database(env).prepare(`INSERT INTO version_deployments
    (id, product_key, environment, version, build_id, commit_sha, deployment_url, status, deployed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, deployment_url = excluded.deployment_url, deployed_at = excluded.deployed_at`)
    .bind(id, product, environment, version, buildId, typeof body.commit === 'string' ? body.commit : null,
      typeof body.url === 'string' ? body.url : null, status, typeof body.deployedAt === 'number' ? body.deployedAt : now, now).run()
  return json(request, env, { accepted: true, id }, 202)
}
