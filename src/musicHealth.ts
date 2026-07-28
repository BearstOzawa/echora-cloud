import { HttpError, json, readJson } from './http'
import { configStore, musicProviderIds, type MusicProviderId } from './systemConfig'
import { musicPlaybackRateKey, verifyMusicPlaybackToken } from './musicPlaybackToken'
import { sha256 } from './crypto'
import type { WorkerEnv } from './types'

export type MusicHealthOperation = 'search' | 'chart' | 'resolve' | 'playback'
export type MusicHealthOutcome = 'success' | 'error' | 'delegated'

export type MusicHealthEvent = {
  providerId: MusicProviderId
  operation: MusicHealthOperation
  outcome: MusicHealthOutcome
  latencyMs: number
  downgraded?: boolean
  error?: unknown
  occurredAt?: number
}

type HealthAggregateRow = {
  provider_id: MusicProviderId
  operation: MusicHealthOperation
  request_count: number
  success_count: number
  error_count: number
  delegated_count: number
  latency_total_ms: number
  downgrade_count: number
  last_error_code: string | null
  last_error_message: string | null
  last_error_at: number | null
}

export type MusicProviderHealth = {
  providerId: MusicProviderId
  requestCount: number
  successCount: number
  errorCount: number
  delegatedCount: number
  averageLatencyMs: number | null
  downgradeCount: number
  successRate: number | null
  lastError: { code: string; message: string; at: number } | null
  operations: Record<MusicHealthOperation, {
    requestCount: number
    successCount: number
    errorCount: number
    delegatedCount: number
    averageLatencyMs: number | null
    downgradeCount: number
  }>
}

const operations: MusicHealthOperation[] = ['search', 'chart', 'resolve', 'playback']
const playbackReasons = new Set(['start_timeout', 'stalled', 'media_error', 'start_failed', 'format_unsupported', 'network', 'unknown'])
const qualities = ['128k', '320k', 'flac', 'flac24bit'] as const
const playbackReasonMessages: Record<string, string> = {
  start_timeout: '播放源响应超时',
  stalled: '播放未能持续进行',
  media_error: '媒体资源无法播放',
  start_failed: '无法开始播放',
  format_unsupported: '媒体格式不受支持',
  network: '媒体连接中断',
  unknown: '播放未完成',
}
const dayKey = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10)
const dayFloor = (days: number) => dayKey(Date.now() - Math.max(0, days - 1) * 86_400_000)

const sanitizeError = (error: unknown) => {
  const code = error instanceof HttpError ? error.code : 'music_request_failed'
  const rawMessage = error instanceof Error ? error.message : '音乐平台暂时无法响应'
  const message = rawMessage
    .replace(/https?:\/\/\S+/gi, '上游服务')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || '音乐平台暂时无法响应'
  return { code: String(code).slice(0, 64), message }
}

export const recordMusicProviderHealth = async (env: WorkerEnv, event: MusicHealthEvent) => {
  if (!env.DB) return
  const timestamp = event.occurredAt ?? Date.now()
  const error = event.outcome === 'error' ? sanitizeError(event.error) : null
  await env.DB.prepare(`INSERT INTO music_provider_health_daily (
      day, provider_id, operation, request_count, success_count, error_count,
      delegated_count, latency_total_ms, downgrade_count,
      last_error_code, last_error_message, last_error_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, provider_id, operation) DO UPDATE SET
      request_count = request_count + 1,
      success_count = success_count + excluded.success_count,
      error_count = error_count + excluded.error_count,
      delegated_count = delegated_count + excluded.delegated_count,
      latency_total_ms = latency_total_ms + excluded.latency_total_ms,
      downgrade_count = downgrade_count + excluded.downgrade_count,
      last_error_code = COALESCE(excluded.last_error_code, last_error_code),
      last_error_message = COALESCE(excluded.last_error_message, last_error_message),
      last_error_at = COALESCE(excluded.last_error_at, last_error_at),
      updated_at = excluded.updated_at`)
    .bind(
      dayKey(timestamp),
      event.providerId,
      event.operation,
      event.outcome === 'success' ? 1 : 0,
      event.outcome === 'error' ? 1 : 0,
      event.outcome === 'delegated' ? 1 : 0,
      Math.max(0, Math.min(120_000, Math.round(event.latencyMs || 0))),
      event.downgraded ? 1 : 0,
      error?.code ?? null,
      error?.message ?? null,
      error ? timestamp : null,
      timestamp,
    ).run()
}

export const trackMusicProviderHealth = async (env: WorkerEnv, event: MusicHealthEvent, execution?: ExecutionContext) => {
  const task = recordMusicProviderHealth(env, event).catch(() => undefined)
  if (execution) {
    execution.waitUntil(task)
    return
  }
  await task
}

type PlaybackHealthInput = {
  source?: unknown
  outcome?: unknown
  latencyMs?: unknown
  reason?: unknown
  requestedQuality?: unknown
  resolvedQuality?: unknown
  playbackToken?: unknown
}

const playbackEventKeys = new Set(['source', 'outcome', 'latencyMs', 'reason', 'requestedQuality', 'resolvedQuality', 'playbackToken'])

export const ingestMusicPlaybackHealth = async (request: Request, env: WorkerEnv, execution?: ExecutionContext) => {
  const deviceId = request.headers.get('X-Echora-Device') || ''
  if (!/^[A-Za-z0-9._:-]{1,96}$/.test(deviceId)) throw new HttpError(400, '终端标识无效', 'invalid_device')
  const rate = await env.AUTH_RATE_LIMITER?.limit({ key: await musicPlaybackRateKey(deviceId) })
  if (rate && !rate.success) throw new HttpError(429, '播放状态提交过于频繁', 'playback_health_rate_limited')
  const body = await readJson<{ events?: unknown }>(request, 16 * 1024)
  if (Object.keys(body).some((key) => key !== 'events')) throw new HttpError(400, '播放状态包含未允许的字段', 'invalid_playback_health')
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 2) throw new HttpError(400, '播放状态数据无效', 'invalid_playback_health')
  const verifiedEvents: Array<{ health: MusicHealthEvent; token: string; expiresAt: number }> = []
  for (const value of body.events) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '播放状态数据无效', 'invalid_playback_health')
    if (Object.keys(value).some((key) => !playbackEventKeys.has(key))) throw new HttpError(400, '播放状态包含未允许的字段', 'invalid_playback_health')
    const event = value as PlaybackHealthInput
    const providerId = typeof event.source === 'string' && musicProviderIds.includes(event.source as MusicProviderId) ? event.source as MusicProviderId : null
    const outcome = event.outcome === 'success' || event.outcome === 'error' ? event.outcome : null
    const latencyMs = typeof event.latencyMs === 'number' && Number.isFinite(event.latencyMs) && event.latencyMs >= 0 ? event.latencyMs : null
    const reason = event.reason == null ? 'unknown' : typeof event.reason === 'string' && playbackReasons.has(event.reason) ? event.reason : null
    const requestedQuality = typeof event.requestedQuality === 'string' && qualities.includes(event.requestedQuality as typeof qualities[number]) ? event.requestedQuality as typeof qualities[number] : null
    const resolvedQuality = typeof event.resolvedQuality === 'string' && qualities.includes(event.resolvedQuality as typeof qualities[number]) ? event.resolvedQuality as typeof qualities[number] : null
    if (!providerId || !outcome || latencyMs == null || !reason || !requestedQuality || !resolvedQuality || outcome === 'success' && event.reason != null) throw new HttpError(400, '播放状态数据无效', 'invalid_playback_health')
    const verified = await verifyMusicPlaybackToken(request, env, event.playbackToken)
    if (verified.providerId !== providerId || verified.requestedQuality !== requestedQuality || verified.resolvedQuality !== resolvedQuality) {
      throw new HttpError(403, '播放状态与凭证不一致', 'invalid_playback_token')
    }
    const downgraded = Boolean(requestedQuality && resolvedQuality && qualities.indexOf(resolvedQuality) < qualities.indexOf(requestedQuality))
    verifiedEvents.push({
      token: verified.token,
      expiresAt: verified.expiresAt,
      health: {
        providerId,
        operation: 'playback',
        outcome,
        latencyMs,
        downgraded,
        error: outcome === 'error' ? new HttpError(422, playbackReasonMessages[reason], reason) : undefined,
      },
    })
  }
  const store = configStore(env)
  let accepted = 0
  let ignored = 0
  for (const event of verifiedEvents) {
    const receiptKey = `music:playback-health:${(await sha256(event.token)).slice(0, 32)}:${event.health.outcome}`
    const canDeduplicate = Boolean(store && typeof (store as unknown as { put?: unknown }).put === 'function')
    if (canDeduplicate && await store!.get(receiptKey)) {
      ignored += 1
      continue
    }
    if (canDeduplicate) await store!.put(receiptKey, '1', { expirationTtl: Math.max(60, event.expiresAt - Math.floor(Date.now() / 1000)) })
    await trackMusicProviderHealth(env, event.health, execution)
    accepted += 1
  }
  return json(request, env, { accepted, ignored }, 202)
}

const emptyOperation = () => ({ requestCount: 0, successCount: 0, errorCount: 0, delegatedCount: 0, averageLatencyMs: null as number | null, downgradeCount: 0 })

export const readMusicProviderHealth = async (env: WorkerEnv, days = 7): Promise<MusicProviderHealth[]> => {
  const normalizedDays = days === 30 ? 30 : 7
  const rows = env.DB
    ? (await env.DB.prepare(`SELECT
        h.provider_id,
        h.operation,
        SUM(h.request_count) AS request_count,
        SUM(h.success_count) AS success_count,
        SUM(h.error_count) AS error_count,
        SUM(h.delegated_count) AS delegated_count,
        SUM(h.latency_total_ms) AS latency_total_ms,
        SUM(h.downgrade_count) AS downgrade_count,
        (SELECT e.last_error_code FROM music_provider_health_daily e
          WHERE e.provider_id = h.provider_id AND e.operation = h.operation
            AND e.day >= ? AND e.last_error_at IS NOT NULL
          ORDER BY e.last_error_at DESC LIMIT 1) AS last_error_code,
        (SELECT e.last_error_message FROM music_provider_health_daily e
          WHERE e.provider_id = h.provider_id AND e.operation = h.operation
            AND e.day >= ? AND e.last_error_at IS NOT NULL
          ORDER BY e.last_error_at DESC LIMIT 1) AS last_error_message,
        MAX(h.last_error_at) AS last_error_at
      FROM music_provider_health_daily h
      WHERE h.day >= ?
      GROUP BY h.provider_id, h.operation`)
      .bind(dayFloor(normalizedDays), dayFloor(normalizedDays), dayFloor(normalizedDays)).all<HealthAggregateRow>()).results
    : []

  return musicProviderIds.map((providerId) => {
    const providerRows = rows.filter((row) => row.provider_id === providerId)
    const operationValues = Object.fromEntries(operations.map((operation) => {
      const row = providerRows.find((candidate) => candidate.operation === operation)
      const requestCount = Number(row?.request_count || 0)
      return [operation, row ? {
        requestCount,
        successCount: Number(row.success_count || 0),
        errorCount: Number(row.error_count || 0),
        delegatedCount: Number(row.delegated_count || 0),
        averageLatencyMs: requestCount ? Math.round(Number(row.latency_total_ms || 0) / requestCount) : null,
        downgradeCount: Number(row.downgrade_count || 0),
      } : emptyOperation()]
    })) as MusicProviderHealth['operations']
    const requestCount = providerRows.reduce((sum, row) => sum + Number(row.request_count || 0), 0)
    const successCount = providerRows.reduce((sum, row) => sum + Number(row.success_count || 0), 0)
    const errorCount = providerRows.reduce((sum, row) => sum + Number(row.error_count || 0), 0)
    const delegatedCount = providerRows.reduce((sum, row) => sum + Number(row.delegated_count || 0), 0)
    const latencyTotal = providerRows.reduce((sum, row) => sum + Number(row.latency_total_ms || 0), 0)
    const resolvedSamples = successCount + errorCount
    const latestError = providerRows
      .filter((row) => row.last_error_at && row.last_error_code && row.last_error_message)
      .sort((left, right) => Number(right.last_error_at) - Number(left.last_error_at))[0]
    return {
      providerId,
      requestCount,
      successCount,
      errorCount,
      delegatedCount,
      averageLatencyMs: requestCount ? Math.round(latencyTotal / requestCount) : null,
      downgradeCount: providerRows.reduce((sum, row) => sum + Number(row.downgrade_count || 0), 0),
      successRate: resolvedSamples ? successCount / resolvedSamples : null,
      lastError: latestError ? { code: latestError.last_error_code!, message: latestError.last_error_message!, at: Number(latestError.last_error_at) } : null,
      operations: operationValues,
    }
  })
}

export const orderMusicProvidersByHealth = async <T extends MusicProviderId>(env: WorkerEnv, operation: MusicHealthOperation, providers: T[]): Promise<T[]> => {
  if (!env.DB || providers.length < 2) return providers
  try {
    const health = await readMusicProviderHealth(env, 7)
    const samplePenalty = (sample: MusicProviderHealth['operations'][MusicHealthOperation] | undefined) => {
      if (!sample || sample.successCount + sample.errorCount < 5) return 0
      const rate = sample.successCount / (sample.successCount + sample.errorCount)
      const reliabilityPenalty = rate >= .75 ? 0 : rate >= .5 ? 1 : rate >= .25 ? 2 : 3
      const latencyPenalty = (sample.averageLatencyMs || 0) >= 8_000 ? .5 : 0
      return reliabilityPenalty + latencyPenalty
    }
    const penalty = (providerId: MusicProviderId) => {
      const provider = health.find((candidate) => candidate.providerId === providerId)
      return Math.max(samplePenalty(provider?.operations[operation]), samplePenalty(provider?.operations.playback))
    }
    return providers
      .map((providerId, index) => ({ providerId, index, score: index + penalty(providerId) }))
      .sort((left, right) => left.score - right.score || left.index - right.index)
      .map((item) => item.providerId)
  } catch {
    return providers
  }
}

export const cleanupMusicProviderHealth = async (env: WorkerEnv, retentionDays = 30) => {
  if (!env.DB) return
  const cutoff = dayKey(Date.now() - Math.max(1, retentionDays) * 86_400_000)
  await env.DB.prepare('DELETE FROM music_provider_health_daily WHERE day < ?').bind(cutoff).run()
}
