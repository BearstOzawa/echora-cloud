import { sha256 } from './crypto'
import { HttpError } from './http'
import { readSystemConfig } from './systemConfig'
import { readRuntimeCredentials } from './systemCredentials'
import type { WorkerEnv } from './types'

export type TurnstileAction = 'register' | 'login' | 'recover' | 'restore' | 'admin_login'

type TurnstileResult = {
  success?: boolean
  action?: string
  hostname?: string
  'error-codes'?: string[]
}

const turnstileConfig = async (env: WorkerEnv) => {
  const [config, credentials] = await Promise.all([readSystemConfig(env), readRuntimeCredentials(env)])
  return {
    enabled: config.features.turnstile && Boolean(credentials.turnstile.siteKey && credentials.turnstile.secretKey),
    siteKey: credentials.turnstile.siteKey,
    secretKey: credentials.turnstile.secretKey,
  }
}

const challengeError = (siteKey: string, action: TurnstileAction) => new HttpError(403, '需要完成人机验证', 'challenge_required', {
  challenge: { provider: 'turnstile', siteKey, action },
})

export const requireTurnstile = async (request: Request, env: WorkerEnv, token: unknown, action: TurnstileAction) => {
  const config = await turnstileConfig(env)
  if (!config.enabled) return
  if (typeof token !== 'string' || !token.trim()) throw challengeError(config.siteKey, action)
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: config.secretKey,
      response: token.trim(),
      remoteip: request.headers.get('CF-Connecting-IP') || undefined,
      idempotency_key: crypto.randomUUID(),
    }),
  })
  const result = await response.json().catch(() => ({})) as TurnstileResult
  if (!response.ok || !result.success || result.action !== action) throw challengeError(config.siteKey, action)
}

const riskKey = async (request: Request, username: string) => sha256([
  username,
  request.headers.get('X-Echora-Device') || 'unknown-device',
  request.headers.get('CF-Connecting-IP') || 'unknown-network',
].join('|'))

export const loginNeedsChallenge = async (request: Request, env: WorkerEnv, username: string) => {
  if (!(await turnstileConfig(env)).enabled) return false
  const rate = await env.AUTH_RATE_LIMITER?.limit({ key: `login:${username}` })
  if (rate && !rate.success) return true
  if (!env.DB) return false
  const row = await env.DB.prepare('SELECT failures, challenge_until FROM auth_risk WHERE risk_key = ?')
    .bind(await riskKey(request, username)).first<{ failures: number; challenge_until: number | null }>()
  return Boolean(row && (row.failures >= 3 || (row.challenge_until && row.challenge_until > Date.now())))
}

export const recordLoginFailure = async (request: Request, env: WorkerEnv, username: string) => {
  if (!env.DB) return
  const key = await riskKey(request, username)
  const now = Date.now()
  const current = await env.DB.prepare('SELECT failures, window_started_at FROM auth_risk WHERE risk_key = ?')
    .bind(key).first<{ failures: number; window_started_at: number }>()
  const failures = !current || now - current.window_started_at > 15 * 60_000 ? 1 : current.failures + 1
  const windowStartedAt = failures === 1 ? now : current!.window_started_at
  const challengeUntil = failures >= 3 ? now + 15 * 60_000 : null
  await env.DB.prepare(`INSERT INTO auth_risk (risk_key, failures, window_started_at, challenge_until, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(risk_key) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at,
      challenge_until = excluded.challenge_until, updated_at = excluded.updated_at`)
    .bind(key, failures, windowStartedAt, challengeUntil, now).run()
}

export const clearLoginRisk = async (request: Request, env: WorkerEnv, username: string) => {
  if (!env.DB) return
  await env.DB.prepare('DELETE FROM auth_risk WHERE risk_key = ?').bind(await riskKey(request, username)).run()
}

export const cleanupAuthRisk = async (env: WorkerEnv) => {
  if (!env.DB) return
  await env.DB.prepare('DELETE FROM auth_risk WHERE updated_at < ?').bind(Date.now() - 24 * 60 * 60_000).run()
}
