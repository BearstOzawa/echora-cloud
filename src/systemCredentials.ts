import { decryptJson, encryptJson } from './crypto'
import { HttpError } from './http'
import { configStore } from './systemConfig'
import type { WorkerEnv } from './types'

export type ManagedAiProvider = 'openai' | 'anthropic' | 'compatible'

export type RuntimeCredentials = {
  musicResolverKey: string
  turnstile: {
    siteKey: string
    secretKey: string
  }
  ai: {
    provider: ManagedAiProvider
    baseUrl: string
    model: string
    apiKey: string
  }
}

export type RuntimeCredentialUpdate = {
  musicResolverKey?: string | null
  turnstileSiteKey?: string | null
  turnstileSecretKey?: string | null
  aiProvider?: ManagedAiProvider
  aiBaseUrl?: string | null
  aiModel?: string | null
  aiApiKey?: string | null
}

type StoredCredentials = {
  musicResolverKey?: string
  turnstileSiteKey?: string
  turnstileSecretKey?: string
  aiProvider?: ManagedAiProvider
  aiBaseUrl?: string
  aiModel?: string
  aiApiKey?: string
}

type EncryptedCredentials = {
  ciphertext: string
  iv: string
  keyVersion: number
}

const storageKey = 'system:credentials:v1'

const normalizeProvider = (value: unknown): ManagedAiProvider => {
  const provider = typeof value === 'string' ? value.toLocaleLowerCase() : ''
  return provider === 'anthropic' || provider === 'compatible' ? provider : 'openai'
}

const readStoredCredentials = async (env: WorkerEnv): Promise<StoredCredentials> => {
  const encrypted = await configStore(env)?.get<EncryptedCredentials>(storageKey, 'json')
  if (!encrypted) return {}
  if (!env.DATA_ENCRYPTION_KEY) throw new HttpError(503, '系统凭据加密尚未完成配置', 'encryption_unavailable')
  try {
    return await decryptJson<StoredCredentials>(encrypted.ciphertext, encrypted.iv, env.DATA_ENCRYPTION_KEY)
  } catch {
    throw new HttpError(503, '系统凭据暂时无法读取', 'system_credentials_unavailable')
  }
}

export const readRuntimeCredentials = async (env: WorkerEnv): Promise<RuntimeCredentials> => {
  const stored = await readStoredCredentials(env)
  return {
    musicResolverKey: stored.musicResolverKey ?? env.ECHORA_MUSIC_RESOLVER_KEY ?? '',
    turnstile: {
      siteKey: stored.turnstileSiteKey ?? env.TURNSTILE_SITE_KEY ?? '',
      secretKey: stored.turnstileSecretKey ?? env.TURNSTILE_SECRET_KEY ?? '',
    },
    ai: {
      provider: normalizeProvider(stored.aiProvider ?? env.ECHORA_AI_PROVIDER),
      baseUrl: stored.aiBaseUrl ?? env.ECHORA_AI_BASE_URL ?? '',
      model: stored.aiModel ?? env.ECHORA_AI_MODEL ?? '',
      apiKey: stored.aiApiKey ?? env.ECHORA_AI_API_KEY ?? '',
    },
  }
}

const updatedValue = (value: string | null | undefined, current: string, maximum: number) => {
  if (value === undefined) return current
  if (value === null) return ''
  return value.trim().slice(0, maximum)
}

export const updateRuntimeCredentials = async (env: WorkerEnv, update: RuntimeCredentialUpdate) => {
  const store = configStore(env)
  if (!store) throw new HttpError(503, '系统配置存储尚未完成绑定', 'config_unavailable')
  if (!env.DATA_ENCRYPTION_KEY) throw new HttpError(503, '系统凭据加密尚未完成配置', 'encryption_unavailable')
  const current = await readRuntimeCredentials(env)
  const next: StoredCredentials = {
    musicResolverKey: updatedValue(update.musicResolverKey, current.musicResolverKey, 512),
    turnstileSiteKey: updatedValue(update.turnstileSiteKey, current.turnstile.siteKey, 256),
    turnstileSecretKey: updatedValue(update.turnstileSecretKey, current.turnstile.secretKey, 512),
    aiProvider: update.aiProvider ? normalizeProvider(update.aiProvider) : current.ai.provider,
    aiBaseUrl: updatedValue(update.aiBaseUrl, current.ai.baseUrl, 512),
    aiModel: updatedValue(update.aiModel, current.ai.model, 128),
    aiApiKey: updatedValue(update.aiApiKey, current.ai.apiKey, 1024),
  }
  const encrypted = await encryptJson(next, env.DATA_ENCRYPTION_KEY)
  await store.put(storageKey, JSON.stringify(encrypted))
  return readRuntimeCredentials(env)
}

export const runtimeCredentialSummary = (credentials: RuntimeCredentials) => ({
  music: { configured: Boolean(credentials.musicResolverKey) },
  turnstile: { configured: Boolean(credentials.turnstile.siteKey && credentials.turnstile.secretKey), siteKey: credentials.turnstile.siteKey },
  ai: {
    configured: Boolean(credentials.ai.baseUrl && credentials.ai.model && credentials.ai.apiKey),
    provider: credentials.ai.provider,
    baseUrl: credentials.ai.baseUrl,
    model: credentials.ai.model,
  },
})
