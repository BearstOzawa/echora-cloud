import { authenticate } from './auth'
import { decryptJson, encryptJson } from './crypto'
import { empty, HttpError, json, readJson } from './http'
import type { WorkerEnv } from './types'
import { readSystemConfig } from './systemConfig'

const collections = new Set(['preferences', 'appearance', 'playlists', 'favorites', 'conversations', 'memories', 'recent'])
const safeIdentifier = /^[A-Za-z0-9._:-]{1,128}$/
const maximumSyncEntityBytes = 2 * 1024 * 1024
const maximumSyncRequestBytes = 4 * 1024 * 1024

const requireCustomAi = async (env: WorkerEnv) => {
  if (!(await readSystemConfig(env)).features.customAi) throw new HttpError(503, '自定义 AI 当前暂停服务', 'custom_ai_disabled')
}

const database = (env: WorkerEnv) => {
  if (!env.DB) throw new HttpError(503, '账户数据服务暂不可用', 'database_unavailable')
  return env.DB
}

const encryptionSecret = (env: WorkerEnv) => {
  if (!env.DATA_ENCRYPTION_KEY) throw new HttpError(503, '凭据加密尚未完成配置', 'encryption_unavailable')
  return env.DATA_ENCRYPTION_KEY
}

type PushOperation = {
  operationId?: unknown
  collection?: unknown
  entityId?: unknown
  payload?: unknown
  deleted?: unknown
}

const normalizedOperation = (value: PushOperation) => {
  const operationId = typeof value.operationId === 'string' ? value.operationId : ''
  const collection = typeof value.collection === 'string' ? value.collection : ''
  const entityId = typeof value.entityId === 'string' ? value.entityId : ''
  if (!safeIdentifier.test(operationId) || !collections.has(collection) || !safeIdentifier.test(entityId)) throw new HttpError(400, '数据更改包含无效标识', 'invalid_sync_operation')
  const deleted = value.deleted === true
  const payloadJson = deleted ? null : JSON.stringify(value.payload ?? null)
  if (payloadJson && new TextEncoder().encode(payloadJson).byteLength > maximumSyncEntityBytes) throw new HttpError(413, '这项账户内容暂时无法保存', 'sync_entity_too_large')
  return { operationId, collection, entityId, payloadJson, deleted }
}

export const pullChanges = async (request: Request, env: WorkerEnv) => {
  const context = await authenticate(request, env)
  const url = new URL(request.url)
  const cursor = Math.max(0, Number(url.searchParams.get('cursor') || 0) || 0)
  const limit = Math.max(1, Math.min(250, Number(url.searchParams.get('limit') || 100) || 100))
  const result = await database(env).prepare(`SELECT change_id, collection, entity_id, revision, payload_json, deleted, device_id, updated_at
    FROM sync_changes WHERE user_id = ? AND change_id > ? ORDER BY change_id ASC LIMIT ?`)
    .bind(context.user.id, cursor, limit + 1).all<any>()
  const rows = result.results.slice(0, limit)
  const changes = rows.map((row) => ({
    changeId: row.change_id,
    collection: row.collection,
    entityId: row.entity_id,
    revision: row.revision,
    payload: row.deleted ? null : JSON.parse(row.payload_json || 'null'),
    deleted: Boolean(row.deleted),
    deviceId: row.device_id,
    updatedAt: row.updated_at,
  }))
  return json(request, env, { changes, cursor: changes.at(-1)?.changeId ?? cursor, hasMore: result.results.length > limit })
}

export const pushChanges = async (request: Request, env: WorkerEnv) => {
  const context = await authenticate(request, env)
  const body = await readJson<{ operations?: PushOperation[] }>(request, maximumSyncRequestBytes)
  if (!Array.isArray(body.operations) || !body.operations.length || body.operations.length > 100) throw new HttpError(400, '每次可提交 1–100 项更改', 'invalid_sync_batch')
  const operations = body.operations.map(normalizedOperation)
  const accepted: Array<{ operationId: string; collection: string; entityId: string; revision: number; changeId: number }> = []
  for (const operation of operations) {
    const prior = await database(env).prepare('SELECT change_id, revision FROM sync_changes WHERE user_id = ? AND device_id = ? AND operation_id = ?')
      .bind(context.user.id, context.deviceId, operation.operationId).first<{ change_id: number; revision: number }>()
    if (prior) {
      accepted.push({ operationId: operation.operationId, collection: operation.collection, entityId: operation.entityId, revision: prior.revision, changeId: prior.change_id })
      continue
    }
    const current = await database(env).prepare('SELECT revision FROM sync_entities WHERE user_id = ? AND collection = ? AND entity_id = ?')
      .bind(context.user.id, operation.collection, operation.entityId).first<{ revision: number }>()
    const revision = (current?.revision ?? 0) + 1
    const now = Date.now()
    await database(env).batch([
      database(env).prepare(`INSERT INTO sync_entities (user_id, collection, entity_id, revision, payload_json, deleted, device_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json, deleted = excluded.deleted, device_id = excluded.device_id, updated_at = excluded.updated_at`)
        .bind(context.user.id, operation.collection, operation.entityId, revision, operation.payloadJson, operation.deleted ? 1 : 0, context.deviceId, now),
      database(env).prepare(`INSERT INTO sync_changes (user_id, collection, entity_id, revision, payload_json, deleted, device_id, operation_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(context.user.id, operation.collection, operation.entityId, revision, operation.payloadJson, operation.deleted ? 1 : 0, context.deviceId, operation.operationId, now),
    ])
    const change = await database(env).prepare('SELECT change_id FROM sync_changes WHERE user_id = ? AND device_id = ? AND operation_id = ?')
      .bind(context.user.id, context.deviceId, operation.operationId).first<{ change_id: number }>()
    accepted.push({ operationId: operation.operationId, collection: operation.collection, entityId: operation.entityId, revision, changeId: change?.change_id ?? 0 })
  }
  return json(request, env, { accepted })
}

export type CustomAiCredential = {
  provider: 'openai' | 'anthropic' | 'compatible' | 'ollama'
  baseUrl: string
  model: string
  apiKey: string
}

export const readCustomAiCredential = async (env: WorkerEnv, userId: string): Promise<CustomAiCredential | null> => {
  const row = await database(env).prepare('SELECT ciphertext, iv FROM user_credentials WHERE user_id = ? AND kind = ?')
    .bind(userId, 'custom_ai').first<{ ciphertext: string; iv: string }>()
  if (!row) return null
  return decryptJson<CustomAiCredential>(row.ciphertext, row.iv, encryptionSecret(env))
}

const normalizeCredential = (value: unknown): CustomAiCredential => {
  const input = value && typeof value === 'object' ? value as Partial<CustomAiCredential> : {}
  const providers = new Set(['openai', 'anthropic', 'compatible', 'ollama'])
  const provider = providers.has(String(input.provider)) ? input.provider as CustomAiCredential['provider'] : 'compatible'
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim().slice(0, 2048) : ''
  const model = typeof input.model === 'string' ? input.model.trim().slice(0, 128) : ''
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim().slice(0, 4096) : ''
  if (!baseUrl || !model || provider !== 'ollama' && !apiKey) throw new HttpError(400, '自定义 AI 配置不完整', 'invalid_ai_credential')
  let endpoint: URL
  try { endpoint = new URL(baseUrl) } catch { throw new HttpError(400, 'AI 接口地址无效', 'invalid_ai_endpoint') }
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new HttpError(400, 'AI 接口地址无效', 'invalid_ai_endpoint')
  return { provider, baseUrl: endpoint.toString().replace(/\/$/, ''), model, apiKey }
}

export const getCredential = async (request: Request, env: WorkerEnv) => {
  await requireCustomAi(env)
  const context = await authenticate(request, env)
  const credential = await readCustomAiCredential(env, context.user.id)
  return json(request, env, { credential })
}

export const putCredential = async (request: Request, env: WorkerEnv) => {
  await requireCustomAi(env)
  const context = await authenticate(request, env)
  const body = await readJson<{ credential?: unknown }>(request)
  const credential = normalizeCredential(body.credential)
  const encrypted = await encryptJson(credential, encryptionSecret(env))
  const now = Date.now()
  await database(env).prepare(`INSERT INTO user_credentials (user_id, kind, ciphertext, iv, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, kind) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, key_version = excluded.key_version, updated_at = excluded.updated_at`)
    .bind(context.user.id, 'custom_ai', encrypted.ciphertext, encrypted.iv, encrypted.keyVersion, now).run()
  return json(request, env, { updatedAt: now })
}

export const deleteCredential = async (request: Request, env: WorkerEnv) => {
  await requireCustomAi(env)
  const context = await authenticate(request, env)
  await database(env).prepare('DELETE FROM user_credentials WHERE user_id = ? AND kind = ?').bind(context.user.id, 'custom_ai').run()
  return empty(request, env)
}
