import { createPasswordRecord, passwordHash, randomToken, sha256, timingSafeEqual } from './crypto'
import { empty, HttpError, json, readJson } from './http'
import type { WorkerEnv } from './types'
import { readSystemConfig } from './systemConfig'
import { clearLoginRisk, loginNeedsChallenge, recordLoginFailure, requireTurnstile } from './turnstile'

type UserRow = {
  id: string
  username: string
  display_name: string
  password_hash: string
  password_salt: string
  password_iterations: number
  recovery_hash: string
  recovery_salt: string
  recovery_iterations: number
  avatar_key: string | null
  created_at: number
  deletion_requested_at: number | null
  deletion_due_at: number | null
  disabled_at: number | null
}

export type AuthenticatedUser = {
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
  createdAt: number
}

export type AuthContext = {
  user: AuthenticatedUser
  sessionId: string
  deviceId: string
}

const usernamePattern = /^[A-Za-z0-9_]{3,32}$/
const devicePattern = /^[A-Za-z0-9._:-]{1,96}$/

const database = (env: WorkerEnv) => {
  if (!env.DB) throw new HttpError(503, '账户服务尚未完成配置', 'database_unavailable')
  return env.DB
}

const cloudflarePbkdf2MaxIterations = 100_000

export const passwordIterations = (env: WorkerEnv) => {
  const configured = Number(env.AUTH_PBKDF2_ITERATIONS || cloudflarePbkdf2MaxIterations)
  if (!Number.isFinite(configured)) return cloudflarePbkdf2MaxIterations
  return Math.max(100_000, Math.min(cloudflarePbkdf2MaxIterations, Math.trunc(configured)))
}
const sessionDuration = (env: WorkerEnv) => Math.max(1, Math.min(90, Number(env.SESSION_DAYS || 30))) * 86_400_000

const normalizedUsername = (value: unknown) => {
  const username = typeof value === 'string' ? value.trim() : ''
  if (!usernamePattern.test(username)) throw new HttpError(400, '用户名需要使用 3–32 位字母、数字或下划线', 'invalid_username')
  return username.toLocaleLowerCase('en-US')
}

const validPassword = (value: unknown) => {
  const password = typeof value === 'string' ? value : ''
  if (password.length < 8 || password.length > 128) throw new HttpError(400, '密码长度需要为 8–128 位', 'invalid_password')
  return password
}

const deviceDetails = (request: Request, body: Record<string, unknown>) => {
  const candidate = request.headers.get('X-Echora-Device') || body.deviceId
  const deviceId = typeof candidate === 'string' && devicePattern.test(candidate) ? candidate : `device-${randomToken(12)}`
  const rawName = request.headers.get('X-Echora-Device-Name') || body.deviceName
  const deviceName = typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 64) : 'Echora 设备'
  return { deviceId, deviceName }
}

const publicUser = (row: UserRow, env: WorkerEnv): AuthenticatedUser => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  avatarUrl: row.avatar_key && env.R2_DOWNLOAD_BASE_URL ? `${env.R2_DOWNLOAD_BASE_URL.replace(/\/$/, '')}/${row.avatar_key}` : null,
  createdAt: row.created_at,
})

const createSession = async (env: WorkerEnv, userId: string, deviceId: string, deviceName: string) => {
  const token = randomToken()
  const now = Date.now()
  await database(env).prepare(`INSERT INTO sessions
    (id, user_id, token_hash, device_id, device_name, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id) DO UPDATE SET
      id = excluded.id,
      token_hash = excluded.token_hash,
      device_name = excluded.device_name,
      created_at = excluded.created_at,
      last_seen_at = excluded.last_seen_at,
      expires_at = excluded.expires_at`)
    .bind(crypto.randomUUID(), userId, await sha256(token), deviceId, deviceName, now, now, now + sessionDuration(env)).run()
  return token
}

export const register = async (request: Request, env: WorkerEnv) => {
  if (!(await readSystemConfig(env)).features.registration) throw new HttpError(403, '账户注册暂未开放', 'registration_disabled')
  const body = await readJson<Record<string, unknown>>(request)
  await requireTurnstile(request, env, body.turnstileToken, 'register')
  const username = normalizedUsername(body.username)
  const password = validPassword(body.password)
  const displayName = typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim().slice(0, 32) : username
  const { deviceId, deviceName } = deviceDetails(request, body)
  const passwordRecord = await createPasswordRecord(password, passwordIterations(env))
  const recoveryCode = randomToken(18)
  const recoveryRecord = await createPasswordRecord(recoveryCode, passwordIterations(env))
  const now = Date.now()
  const id = crypto.randomUUID()
  try {
    await database(env).prepare(`INSERT INTO users
      (id, username, display_name, password_hash, password_salt, password_iterations, recovery_hash, recovery_salt, recovery_iterations, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, username, displayName, passwordRecord.hash, passwordRecord.salt, passwordRecord.iterations, recoveryRecord.hash, recoveryRecord.salt, recoveryRecord.iterations, now, now).run()
  } catch (error) {
    if (/unique|constraint/i.test(String(error))) throw new HttpError(409, '这个用户名已被使用', 'username_taken')
    throw error
  }
  const row = await database(env).prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>()
  if (!row) throw new Error('注册后无法读取账户')
  const token = await createSession(env, id, deviceId, deviceName)
  return json(request, env, { token, recoveryCode, user: publicUser(row, env) }, 201)
}

export const login = async (request: Request, env: WorkerEnv) => {
  const body = await readJson<Record<string, unknown>>(request)
  const username = normalizedUsername(body.username)
  const password = validPassword(body.password)
  if (await loginNeedsChallenge(request, env, username)) await requireTurnstile(request, env, body.turnstileToken, 'login')
  const row = await database(env).prepare('SELECT * FROM users WHERE username = ?').bind(username).first<UserRow>()
  if (!row) {
    await recordLoginFailure(request, env, username)
    throw new HttpError(401, '用户名或密码不正确', 'invalid_credentials')
  }
  const hash = await passwordHash(password, row.password_salt, row.password_iterations)
  if (!timingSafeEqual(hash, row.password_hash)) {
    await recordLoginFailure(request, env, username)
    throw new HttpError(401, '用户名或密码不正确', 'invalid_credentials')
  }
  if (row.disabled_at) throw new HttpError(403, '账户已停用', 'account_disabled')
  if (row.deletion_due_at) throw new HttpError(423, '账户正在等待删除，请前往 Echora Cloud 恢复', 'account_pending_deletion')
  const { deviceId, deviceName } = deviceDetails(request, body)
  const token = await createSession(env, row.id, deviceId, deviceName)
  await clearLoginRisk(request, env, username)
  return json(request, env, { token, user: publicUser(row, env) })
}

const bearerToken = (request: Request) => {
  const authorization = request.headers.get('Authorization') || ''
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  if (!match) throw new HttpError(401, '请先登录 Echora', 'authentication_required')
  return match[1]
}

export const authenticate = async (request: Request, env: WorkerEnv): Promise<AuthContext> => {
  const tokenHash = await sha256(bearerToken(request))
  const now = Date.now()
  const row = await database(env).prepare(`SELECT
      s.id AS session_id, s.device_id, s.last_seen_at,
      u.id, u.username, u.display_name, u.avatar_key, u.created_at,
      u.deletion_requested_at, u.deletion_due_at, u.disabled_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(tokenHash, now).first<UserRow & { session_id: string; device_id: string; last_seen_at: number }>()
  if (!row || row.deletion_due_at) throw new HttpError(401, '登录状态已失效', 'session_expired')
  if (row.disabled_at) throw new HttpError(403, '账户已停用', 'account_disabled')
  if (now - row.last_seen_at > 3_600_000) {
    await database(env).prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(now, row.session_id).run()
  }
  return { user: publicUser(row, env), sessionId: row.session_id, deviceId: row.device_id }
}

export const me = async (request: Request, env: WorkerEnv) => json(request, env, { user: (await authenticate(request, env)).user })

export const logout = async (request: Request, env: WorkerEnv) => {
  const context = await authenticate(request, env)
  await database(env).prepare('DELETE FROM sessions WHERE id = ?').bind(context.sessionId).run()
  return empty(request, env)
}

export const updateProfile = async (request: Request, env: WorkerEnv) => {
  const context = await authenticate(request, env)
  const body = await readJson<Record<string, unknown>>(request)
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 32) : ''
  if (!displayName) throw new HttpError(400, '显示名称不能为空', 'invalid_display_name')
  await database(env).prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').bind(displayName, Date.now(), context.user.id).run()
  return json(request, env, { user: { ...context.user, displayName } })
}

export const changePassword = async (request: Request, env: WorkerEnv) => {
  const context = await authenticate(request, env)
  const body = await readJson<Record<string, unknown>>(request)
  const currentPassword = validPassword(body.currentPassword)
  const newPassword = validPassword(body.newPassword)
  if (currentPassword === newPassword) throw new HttpError(400, '新密码不能与当前密码相同', 'password_unchanged')
  const row = await database(env).prepare('SELECT * FROM users WHERE id = ?').bind(context.user.id).first<UserRow>()
  if (!row) throw new HttpError(404, '账户不存在', 'account_not_found')
  const currentHash = await passwordHash(currentPassword, row.password_salt, row.password_iterations)
  if (!timingSafeEqual(currentHash, row.password_hash)) throw new HttpError(401, '当前密码不正确', 'invalid_credentials')
  const passwordRecord = await createPasswordRecord(newPassword, passwordIterations(env))
  const recoveryCode = randomToken(18)
  const recoveryRecord = await createPasswordRecord(recoveryCode, passwordIterations(env))
  const now = Date.now()
  await database(env).batch([
    database(env).prepare(`UPDATE users SET
      password_hash = ?, password_salt = ?, password_iterations = ?,
      recovery_hash = ?, recovery_salt = ?, recovery_iterations = ?, updated_at = ?
      WHERE id = ?`).bind(
        passwordRecord.hash,
        passwordRecord.salt,
        passwordRecord.iterations,
        recoveryRecord.hash,
        recoveryRecord.salt,
        recoveryRecord.iterations,
        now,
        row.id,
      ),
    database(env).prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').bind(row.id, context.sessionId),
  ])
  return json(request, env, { recoveryCode })
}

export const listDevices = async (request: Request, env: WorkerEnv) => {
  const context = await authenticate(request, env)
  const result = await database(env).prepare('SELECT id, device_id, device_name, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC').bind(context.user.id).all()
  return json(request, env, { devices: result.results.map((item: any) => ({ id: item.id, deviceId: item.device_id, name: item.device_name, createdAt: item.created_at, lastSeenAt: item.last_seen_at, expiresAt: item.expires_at, current: item.id === context.sessionId })) })
}

export const revokeDevice = async (request: Request, env: WorkerEnv, sessionId: string) => {
  const context = await authenticate(request, env)
  await database(env).prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').bind(sessionId, context.user.id).run()
  return empty(request, env)
}

export const requestDeletion = async (request: Request, env: WorkerEnv) => {
  const context = await authenticate(request, env)
  const body = await readJson<Record<string, unknown>>(request)
  const password = validPassword(body.password)
  const row = await database(env).prepare('SELECT * FROM users WHERE id = ?').bind(context.user.id).first<UserRow>()
  if (!row) throw new HttpError(404, '账户不存在', 'account_not_found')
  const hash = await passwordHash(password, row.password_salt, row.password_iterations)
  if (!timingSafeEqual(hash, row.password_hash)) throw new HttpError(401, '密码不正确', 'invalid_credentials')
  const requestedAt = Date.now()
  const dueAt = requestedAt + 7 * 86_400_000
  await database(env).batch([
    database(env).prepare('UPDATE users SET deletion_requested_at = ?, deletion_due_at = ?, updated_at = ? WHERE id = ?').bind(requestedAt, dueAt, requestedAt, row.id),
    database(env).prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.id),
  ])
  return json(request, env, { deletionRequestedAt: requestedAt, deletionDueAt: dueAt })
}

export const restoreAccount = async (request: Request, env: WorkerEnv) => {
  const body = await readJson<Record<string, unknown>>(request)
  await requireTurnstile(request, env, body.turnstileToken, 'restore')
  const username = normalizedUsername(body.username)
  const password = validPassword(body.password)
  const row = await database(env).prepare('SELECT * FROM users WHERE username = ?').bind(username).first<UserRow>()
  if (!row?.deletion_due_at || row.deletion_due_at <= Date.now()) throw new HttpError(404, '没有可恢复的账户', 'account_not_recoverable')
  const hash = await passwordHash(password, row.password_salt, row.password_iterations)
  if (!timingSafeEqual(hash, row.password_hash)) throw new HttpError(401, '用户名或密码不正确', 'invalid_credentials')
  await database(env).prepare('UPDATE users SET deletion_requested_at = NULL, deletion_due_at = NULL, updated_at = ? WHERE id = ?').bind(Date.now(), row.id).run()
  return json(request, env, { restored: true })
}

export const resetPasswordWithRecovery = async (request: Request, env: WorkerEnv) => {
  const body = await readJson<Record<string, unknown>>(request)
  await requireTurnstile(request, env, body.turnstileToken, 'recover')
  const username = normalizedUsername(body.username)
  const recoveryCode = typeof body.recoveryCode === 'string' ? body.recoveryCode.trim() : ''
  const newPassword = validPassword(body.newPassword)
  const row = await database(env).prepare('SELECT * FROM users WHERE username = ?').bind(username).first<UserRow>()
  if (!row || !recoveryCode) throw new HttpError(401, '恢复信息不正确', 'invalid_recovery')
  const recoveryHash = await passwordHash(recoveryCode, row.recovery_salt, row.recovery_iterations)
  if (!timingSafeEqual(recoveryHash, row.recovery_hash)) throw new HttpError(401, '恢复信息不正确', 'invalid_recovery')
  const passwordRecord = await createPasswordRecord(newPassword, passwordIterations(env))
  const nextRecoveryCode = randomToken(18)
  const recoveryRecord = await createPasswordRecord(nextRecoveryCode, passwordIterations(env))
  await database(env).batch([
    database(env).prepare('UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, recovery_hash = ?, recovery_salt = ?, recovery_iterations = ?, updated_at = ? WHERE id = ?')
      .bind(passwordRecord.hash, passwordRecord.salt, passwordRecord.iterations, recoveryRecord.hash, recoveryRecord.salt, recoveryRecord.iterations, Date.now(), row.id),
    database(env).prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.id),
  ])
  return json(request, env, { recoveryCode: nextRecoveryCode })
}

export const cleanupDeletedAccounts = async (env: WorkerEnv) => {
  if (!env.DB) return
  const due = await env.DB.prepare('SELECT id, avatar_key FROM users WHERE deletion_due_at IS NOT NULL AND deletion_due_at <= ?').bind(Date.now()).all<{ id: string; avatar_key: string | null }>()
  for (const user of due.results) {
    if (user.avatar_key && env.MEDIA) await env.MEDIA.delete(user.avatar_key).catch(() => undefined)
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run()
  }
}
