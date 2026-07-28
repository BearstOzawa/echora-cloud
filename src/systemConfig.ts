import type { WorkerEnv } from './types'

export const musicProviderIds = ['tx', 'wy', 'kw', 'kg', 'mg'] as const
export type MusicProviderId = typeof musicProviderIds[number]

export type SystemConfig = {
  music: {
    enabledProviders: MusicProviderId[]
    preferredSourceOrder: MusicProviderId[]
  }
  features: {
    registration: boolean
    echoraAi: boolean
    customAi: boolean
    turnstile: boolean
  }
}

export const defaultSystemConfig: SystemConfig = {
  music: { enabledProviders: [...musicProviderIds], preferredSourceOrder: [...musicProviderIds] },
  features: { registration: true, echoraAi: true, customAi: true, turnstile: true },
}

const validProviders = (value: unknown) => Array.isArray(value)
  ? value.filter((provider): provider is MusicProviderId => musicProviderIds.includes(provider as MusicProviderId))
  : []

export const normalizeSystemConfig = (value: unknown): SystemConfig => {
  const input = value && typeof value === 'object' ? value as Partial<SystemConfig> : {}
  const music = input.music && typeof input.music === 'object' ? input.music : defaultSystemConfig.music
  const features = input.features && typeof input.features === 'object' ? input.features : defaultSystemConfig.features
  const enabledProviders = validProviders(music.enabledProviders)
  const enabled = enabledProviders.length ? enabledProviders : [...defaultSystemConfig.music.enabledProviders]
  const order = validProviders(music.preferredSourceOrder)
  return {
    music: {
      enabledProviders: enabled,
      preferredSourceOrder: [...order, ...musicProviderIds.filter((provider) => !order.includes(provider))],
    },
    features: {
      registration: features.registration !== false,
      echoraAi: features.echoraAi !== false,
      customAi: features.customAi !== false,
      turnstile: features.turnstile !== false,
    },
  }
}

export const configStore = (env: WorkerEnv) => env.CONFIG || env.RELEASES

export const readSystemConfig = async (env: WorkerEnv) => {
  const stored = await configStore(env)?.get<Record<string, unknown>>('system:config', 'json')
  return normalizeSystemConfig(stored)
}
