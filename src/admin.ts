import { authenticateAdmin } from './adminAuth'
import { HttpError, json, readJson } from './http'
import type { WorkerEnv } from './types'
import { configStore, musicProviderIds, normalizeSystemConfig, readSystemConfig } from './systemConfig'
import { readRuntimeCredentials, runtimeCredentialSummary, updateRuntimeCredentials } from './systemCredentials'
import type { RuntimeCredentialUpdate } from './systemCredentials'
import { readMusicProviderHealth } from './musicHealth'

export const bootstrap = async (request: Request, env: WorkerEnv) => {
  const config = await readSystemConfig(env)
  const credentials = await readRuntimeCredentials(env)
  return json(request, env, {
    service: 'echora-cloud',
    links: { web: (env.OFFICIAL_WEB_URL || 'https://echora-web.lili.uno').replace(/\/$/, '') },
    music: config.music,
    features: config.features,
    ai: { available: Boolean(credentials.ai.apiKey && credentials.ai.baseUrl && credentials.ai.model) },
    security: { turnstile: config.features.turnstile && Boolean(credentials.turnstile.siteKey && credentials.turnstile.secretKey) },
  }, 200, { 'Cache-Control': 'public, max-age=60' })
}

export const adminConfig = async (request: Request, env: WorkerEnv) => {
  const context = await authenticateAdmin(request, env)
  const store = configStore(env)
  if (!store) throw new HttpError(503, '系统配置存储尚未完成绑定', 'config_unavailable')
  if (request.method === 'GET') {
    const credentials = await readRuntimeCredentials(env)
    return json(request, env, { config: await readSystemConfig(env), credentials: runtimeCredentialSummary(credentials) })
  }
  const body = await readJson<{ config?: unknown; credentials?: RuntimeCredentialUpdate }>(request, 64 * 1024)
  if ((!body.config || typeof body.config !== 'object') && (!body.credentials || typeof body.credentials !== 'object')) throw new HttpError(400, '系统配置无效', 'invalid_system_config')
  const config = body.config && typeof body.config === 'object' ? normalizeSystemConfig(body.config) : await readSystemConfig(env)
  if (body.config) await store.put('system:config', JSON.stringify(config))
  const credentials = body.credentials ? await updateRuntimeCredentials(env, body.credentials) : await readRuntimeCredentials(env)
  if (env.DB) await env.DB.prepare('INSERT INTO admin_audit_log (actor_admin_id, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(context.admin.id, 'config.update', 'system:config', JSON.stringify({ config: Boolean(body.config), credentials: Object.keys(body.credentials || {}) }), Date.now()).run()
  return json(request, env, { config, credentials: runtimeCredentialSummary(credentials) })
}

export const adminUsers = async (request: Request, env: WorkerEnv) => {
  await authenticateAdmin(request, env)
  if (!env.DB) throw new HttpError(503, '账户服务尚未完成配置', 'database_unavailable')
  const url = new URL(request.url)
  const query = (url.searchParams.get('query') || '').trim().slice(0, 48)
  const status = url.searchParams.get('status') || 'all'
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(url.searchParams.get('pageSize') || '25', 10) || 25))
  const sort = url.searchParams.get('sort') || 'created_desc'
  const orderBy = {
    created_desc: 'users.created_at DESC',
    active_desc: 'last_active_at DESC, users.created_at DESC',
    content_desc: 'content_count DESC, users.created_at DESC',
    username_asc: 'users.username COLLATE NOCASE ASC',
  }[sort] || 'users.created_at DESC'
  const clauses: string[] = []
  const values: unknown[] = []
  if (query) {
    clauses.push('(username LIKE ? OR display_name LIKE ?)')
    values.push(`%${query}%`, `%${query}%`)
  }
  if (status === 'active') clauses.push('disabled_at IS NULL AND deletion_due_at IS NULL')
  if (status === 'disabled') clauses.push('disabled_at IS NOT NULL')
  if (status === 'deletion') clauses.push('deletion_due_at IS NOT NULL')
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const total = await env.DB.prepare(`SELECT COUNT(*) AS total FROM users ${where}`).bind(...values).first<{ total: number }>()
  const result = await env.DB.prepare(`SELECT id, username, display_name, created_at, deletion_due_at, disabled_at,
    (SELECT COUNT(*) FROM sessions WHERE sessions.user_id = users.id) AS device_count,
    (SELECT MAX(last_seen_at) FROM sessions WHERE sessions.user_id = users.id) AS last_active_at,
    (SELECT COUNT(*) FROM sync_entities WHERE sync_entities.user_id = users.id AND deleted = 0) AS content_count,
    EXISTS(SELECT 1 FROM user_credentials WHERE user_credentials.user_id = users.id AND kind = 'custom_ai') AS custom_ai_configured
    FROM users ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).bind(...values, pageSize, (page - 1) * pageSize).all<any>()
  return json(request, env, {
    users: result.results.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      createdAt: row.created_at,
      deletionDueAt: row.deletion_due_at,
      disabledAt: row.disabled_at,
      deviceCount: Number(row.device_count || 0),
      lastActiveAt: row.last_active_at ? Number(row.last_active_at) : null,
      contentCount: Number(row.content_count || 0),
      customAiConfigured: Boolean(row.custom_ai_configured),
    })),
    pagination: { page, pageSize, total: Number(total?.total || 0), pages: Math.max(1, Math.ceil(Number(total?.total || 0) / pageSize)) },
  })
}

export const adminUserAction = async (request: Request, env: WorkerEnv, userId: string) => {
  const context = await authenticateAdmin(request, env)
  if (!env.DB) throw new HttpError(503, '账户服务尚未完成配置', 'database_unavailable')
  const target = await env.DB.prepare('SELECT id, disabled_at, deletion_due_at FROM users WHERE id = ?').bind(userId).first<{ id: string; disabled_at: number | null; deletion_due_at: number | null }>()
  if (!target) throw new HttpError(404, '用户不存在', 'user_not_found')
  const body = await readJson<{ action?: unknown }>(request)
  const action = typeof body.action === 'string' ? body.action : ''
  const now = Date.now()
  if (action === 'disable') {
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?').bind(now, now, userId),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    ])
  } else if (action === 'enable') {
    await env.DB.prepare('UPDATE users SET disabled_at = NULL, updated_at = ? WHERE id = ?').bind(now, userId).run()
  } else if (action === 'revoke_sessions') {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run()
  } else if (action === 'cancel_deletion') {
    await env.DB.prepare('UPDATE users SET deletion_requested_at = NULL, deletion_due_at = NULL, updated_at = ? WHERE id = ?').bind(now, userId).run()
  } else {
    throw new HttpError(400, '用户操作无效', 'invalid_admin_user_action')
  }
  await env.DB.prepare('INSERT INTO admin_audit_log (actor_admin_id, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(context.admin.id, `user.${action}`, userId, JSON.stringify({ previousDisabledAt: target.disabled_at, previousDeletionDueAt: target.deletion_due_at }), now).run()
  return json(request, env, { user: { id: userId, disabledAt: action === 'disable' ? now : action === 'enable' ? null : target.disabled_at, deletionDueAt: action === 'cancel_deletion' ? null : target.deletion_due_at } })
}

const providerNames: Record<string, string> = { tx: 'QQ 音乐', wy: '网易云音乐', kw: '酷我音乐', kg: '酷狗音乐', mg: '咪咕音乐' }

export const adminOverview = async (request: Request, env: WorkerEnv) => {
  const context = await authenticateAdmin(request, env)
  if (!env.DB) throw new HttpError(503, '账户服务尚未完成配置', 'database_unavailable')
  const counts = await env.DB.prepare(`SELECT
    COUNT(*) AS users,
    COALESCE(SUM(CASE WHEN disabled_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS disabled_users,
    COALESCE(SUM(CASE WHEN deletion_due_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS pending_deletion,
    COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS new_users_7d,
    (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS sessions,
    (SELECT COUNT(DISTINCT user_id) FROM user_credentials WHERE kind = 'custom_ai') AS custom_ai_users
    FROM users`)
    .bind(Date.now() - 7 * 86_400_000, Date.now()).first<any>()
  const config = await readSystemConfig(env)
  const credentials = await readRuntimeCredentials(env)
  const enabledProviders = new Set(config.music.enabledProviders)
  const activity = await env.DB.prepare(`SELECT action, target, created_at FROM admin_audit_log ORDER BY created_at DESC LIMIT 6`).all<any>()
  return json(request, env, {
    admin: context.admin,
    users: {
      total: Number(counts?.users || 0),
      new7d: Number(counts?.new_users_7d || 0),
      activeSessions: Number(counts?.sessions || 0),
      suspended: Number(counts?.disabled_users || 0),
      pendingDeletion: Number(counts?.pending_deletion || 0),
    },
    music: {
      enabledProviders: config.music.enabledProviders.length,
      totalProviders: musicProviderIds.length,
      resolverConfigured: Boolean(credentials.musicResolverKey),
      providers: config.music.preferredSourceOrder.map((id, index) => ({ id, name: providerNames[id], enabled: enabledProviders.has(id), priority: index + 1 })),
    },
    ai: {
      echoraEnabled: config.features.echoraAi,
      echoraConfigured: Boolean(credentials.ai.apiKey && credentials.ai.baseUrl && credentials.ai.model),
      customEnabled: config.features.customAi,
      customConfiguredUsers: Number(counts?.custom_ai_users || 0),
    },
    recentActivity: activity.results.map((row) => ({ action: row.action, target: row.target, createdAt: row.created_at })),
  })
}

export const adminMusicHealth = async (request: Request, env: WorkerEnv) => {
  await authenticateAdmin(request, env)
  if (!env.DB) throw new HttpError(503, '运行数据存储尚未完成配置', 'database_unavailable')
  const requestedDays = Number.parseInt(new URL(request.url).searchParams.get('days') || '7', 10)
  const days = requestedDays === 30 ? 30 : 7
  const config = await readSystemConfig(env)
  const enabled = new Set(config.music.enabledProviders)
  const health = await readMusicProviderHealth(env, days)
  const byProvider = new Map(health.map((provider) => [provider.providerId, provider]))
  return json(request, env, {
    days,
    providers: config.music.preferredSourceOrder.map((providerId, index) => {
      const sample = byProvider.get(providerId)!
      const state = !enabled.has(providerId)
        ? 'disabled'
        : sample.successRate == null
          ? 'unknown'
          : sample.successRate >= .9
            ? 'healthy'
            : sample.successRate >= .65
              ? 'degraded'
              : 'unavailable'
      return {
        id: providerId,
        name: providerNames[providerId],
        enabled: enabled.has(providerId),
        priority: index + 1,
        state,
        ...sample,
      }
    }),
  })
}

export const adminAudit = async (request: Request, env: WorkerEnv) => {
  await authenticateAdmin(request, env)
  if (!env.DB) throw new HttpError(503, '账户服务尚未完成配置', 'database_unavailable')
  const result = await env.DB.prepare(`SELECT log.id, log.action, log.target, log.detail_json, log.created_at,
      admin.username, admin.display_name
    FROM admin_audit_log log JOIN admin_accounts admin ON admin.id = log.actor_admin_id
    ORDER BY log.created_at DESC LIMIT 100`).all<any>()
  return json(request, env, { events: result.results.map((row) => ({
    id: row.id,
    action: row.action,
    target: row.target,
    detail: row.detail_json ? JSON.parse(row.detail_json) : null,
    createdAt: row.created_at,
    admin: { username: row.username, displayName: row.display_name },
  })) })
}
