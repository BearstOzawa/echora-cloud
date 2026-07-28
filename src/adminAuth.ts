import { passwordIterations } from './auth'
import { createPasswordRecord, passwordHash, randomToken, sha256, timingSafeEqual } from './crypto'
import { empty, HttpError, json, readJson } from './http'
import { requireTurnstile } from './turnstile'
import type { WorkerEnv } from './types'

type AdminRow = {
  id: string
  username: string
  display_name: string
  password_hash: string
  password_salt: string
  password_iterations: number
  disabled_at: number | null
  created_at: number
}

export type AuthenticatedAdmin = {
  id: string
  username: string
  displayName: string
  createdAt: number
}

export type AdminContext = {
  admin: AuthenticatedAdmin
  sessionId: string
}

const cookieName = 'echora_admin_session'
const usernamePattern = /^[A-Za-z0-9_]{3,32}$/

const database = (env: WorkerEnv) => {
  if (!env.DB) throw new HttpError(503, '管理服务尚未完成配置', 'database_unavailable')
  return env.DB
}

const normalizedUsername = (value: unknown) => {
  const username = typeof value === 'string' ? value.trim() : ''
  if (!usernamePattern.test(username)) throw new HttpError(400, '用户名格式不正确', 'invalid_username')
  return username.toLocaleLowerCase('en-US')
}

const validPassword = (value: unknown) => {
  const password = typeof value === 'string' ? value : ''
  if (password.length < 8 || password.length > 128) throw new HttpError(400, '密码长度需要为 8–128 位', 'invalid_password')
  return password
}

const publicAdmin = (row: AdminRow): AuthenticatedAdmin => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  createdAt: row.created_at,
})

const bootstrapUsername = (env: WorkerEnv) => env.ADMIN_BOOTSTRAP_USERNAME?.trim().toLocaleLowerCase('en-US') || ''

export const matchesBootstrapAdmin = (env: WorkerEnv, username: string, password: string) => {
  const expectedPassword = env.ADMIN_BOOTSTRAP_PASSWORD || ''
  return Boolean(bootstrapUsername(env) && expectedPassword && username === bootstrapUsername(env) && timingSafeEqual(password, expectedPassword))
}

const createBootstrapAdmin = async (env: WorkerEnv, username: string, password: string) => {
  const record = await createPasswordRecord(password, passwordIterations(env))
  const now = Date.now()
  await database(env).prepare(`INSERT INTO admin_accounts
    (id, username, display_name, password_hash, password_salt, password_iterations, created_at, updated_at)
    VALUES (?, ?, 'Echora 管理员', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), username, record.hash, record.salt, record.iterations, now, now).run()
}

const sessionDuration = (env: WorkerEnv) => Math.max(1, Math.min(24, Number(env.ADMIN_SESSION_HOURS || 12))) * 3_600_000

const sessionCookie = (request: Request, token: string, maximumAge: number) => {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maximumAge}${secure}`
}

const readCookie = (request: Request) => {
  const entry = (request.headers.get('Cookie') || '').split(';').map((item) => item.trim()).find((item) => item.startsWith(`${cookieName}=`))
  return entry ? decodeURIComponent(entry.slice(cookieName.length + 1)) : ''
}

const enforceSameOrigin = (request: Request) => {
  if (request.method === 'GET' || request.method === 'HEAD') return
  const origin = request.headers.get('Origin')
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, '请求来源无效', 'invalid_origin')
}

export const authenticateAdmin = async (request: Request, env: WorkerEnv): Promise<AdminContext> => {
  enforceSameOrigin(request)
  const token = readCookie(request)
  if (!token) throw new HttpError(401, '请先登录系统管理', 'admin_authentication_required')
  const now = Date.now()
  const row = await database(env).prepare(`SELECT
      s.id AS session_id, s.last_seen_at,
      a.id, a.username, a.display_name, a.disabled_at, a.created_at
    FROM admin_sessions s JOIN admin_accounts a ON a.id = s.admin_id
    WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(await sha256(token), now).first<AdminRow & { session_id: string; last_seen_at: number }>()
  if (!row) throw new HttpError(401, '管理会话已失效', 'admin_session_expired')
  if (row.disabled_at) throw new HttpError(403, '管理员账户已停用', 'admin_account_disabled')
  if (now - row.last_seen_at > 15 * 60_000) {
    await database(env).prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?').bind(now, row.session_id).run()
  }
  return { admin: publicAdmin(row), sessionId: row.session_id }
}

export const adminLogin = async (request: Request, env: WorkerEnv) => {
  const body = await readJson<Record<string, unknown>>(request)
  await requireTurnstile(request, env, body.turnstileToken, 'admin_login')
  const username = normalizedUsername(body.username)
  const password = validPassword(body.password)
  let row = await database(env).prepare('SELECT * FROM admin_accounts WHERE username = ?').bind(username).first<AdminRow>()
  if (!row && matchesBootstrapAdmin(env, username, password)) {
    try { await createBootstrapAdmin(env, username, password) } catch (error) {
      if (!/unique|constraint/i.test(String(error))) throw error
    }
    row = await database(env).prepare('SELECT * FROM admin_accounts WHERE username = ?').bind(username).first<AdminRow>()
  }
  if (!row) throw new HttpError(401, '用户名或密码不正确', 'invalid_credentials')
  const hash = await passwordHash(password, row.password_salt, row.password_iterations)
  if (!timingSafeEqual(hash, row.password_hash)) throw new HttpError(401, '用户名或密码不正确', 'invalid_credentials')
  if (row.disabled_at) throw new HttpError(403, '管理员账户已停用', 'admin_account_disabled')
  const token = randomToken()
  const now = Date.now()
  const duration = sessionDuration(env)
  await database(env).batch([
    database(env).prepare('INSERT INTO admin_sessions (id, admin_id, token_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), row.id, await sha256(token), now, now, now + duration),
    database(env).prepare('UPDATE admin_accounts SET last_login_at = ?, updated_at = ? WHERE id = ?').bind(now, now, row.id),
  ])
  return json(request, env, { admin: publicAdmin(row) }, 200, { 'Set-Cookie': sessionCookie(request, token, Math.floor(duration / 1000)) })
}

export const adminMe = async (request: Request, env: WorkerEnv) => json(request, env, { admin: (await authenticateAdmin(request, env)).admin })

export const adminLogout = async (request: Request, env: WorkerEnv) => {
  const context = await authenticateAdmin(request, env)
  await database(env).prepare('DELETE FROM admin_sessions WHERE id = ?').bind(context.sessionId).run()
  return empty(request, env, 204, { 'Set-Cookie': sessionCookie(request, '', 0) })
}

export const changeAdminPassword = async (request: Request, env: WorkerEnv) => {
  const context = await authenticateAdmin(request, env)
  const body = await readJson<Record<string, unknown>>(request)
  const currentPassword = validPassword(body.currentPassword)
  const newPassword = validPassword(body.newPassword)
  if (currentPassword === newPassword) throw new HttpError(400, '新密码不能与当前密码相同', 'password_unchanged')
  const row = await database(env).prepare('SELECT * FROM admin_accounts WHERE id = ?').bind(context.admin.id).first<AdminRow>()
  if (!row) throw new HttpError(404, '管理员账户不存在', 'admin_not_found')
  const currentHash = await passwordHash(currentPassword, row.password_salt, row.password_iterations)
  if (!timingSafeEqual(currentHash, row.password_hash)) throw new HttpError(401, '当前密码不正确', 'invalid_credentials')
  const next = await createPasswordRecord(newPassword, passwordIterations(env))
  const now = Date.now()
  await database(env).batch([
    database(env).prepare('UPDATE admin_accounts SET password_hash = ?, password_salt = ?, password_iterations = ?, updated_at = ? WHERE id = ?')
      .bind(next.hash, next.salt, next.iterations, now, row.id),
    database(env).prepare('DELETE FROM admin_sessions WHERE admin_id = ? AND id <> ?').bind(row.id, context.sessionId),
    database(env).prepare('INSERT INTO admin_audit_log (actor_admin_id, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(row.id, 'admin.password.update', row.id, null, now),
  ])
  return empty(request, env)
}
