export type UpdatePlatform = 'web' | 'desktop' | 'mobile'
export type VersionProductKey = 'echora-web' | 'echora-cloud' | 'echora-desktop' | 'echora-android' | 'echora-ios'
export type VersionReleaseStatus = 'draft' | 'pending' | 'published' | 'paused' | 'withdrawn'
export type UpdateActionType = 'web-refresh' | 'tauri-update' | 'github-release' | 'apk-download' | 'ipa-download'

export type ReleaseAction = {
  type: UpdateActionType
  url: string
  fallbackUrl?: string
  label?: string
  signature?: string
  sha256?: string
  size?: number
  tauriTarget?: string
}

export type ReleaseManifest = {
  schemaVersion: 1
  version: string
  minimumVersion: string
  releaseUrl?: string
  buildId?: string
  publishedAt: string
  releaseNotes: string
  rollout?: {
    percentage: number
    salt: string
  }
  actions: Record<string, ReleaseAction>
}

export type WorkerEnv = {
  RELEASES?: KVNamespace
  CONFIG?: KVNamespace
  DB?: D1Database
  MEDIA?: R2Bucket
  ASSETS?: Fetcher
  ALLOWED_ORIGIN?: string
  OFFICIAL_WEB_URL?: string
  GITHUB_REPOSITORY?: string
  GITHUB_TOKEN?: string
  R2_DOWNLOAD_BASE_URL?: string
  AUTH_PBKDF2_ITERATIONS?: string
  SESSION_DAYS?: string
  DATA_ENCRYPTION_KEY?: string
  ECHORA_MUSIC_RESOLVER_KEY?: string
  ECHORA_AI_API_KEY?: string
  ECHORA_AI_BASE_URL?: string
  ECHORA_AI_MODEL?: string
  ECHORA_AI_PROVIDER?: string
  ADMIN_BOOTSTRAP_USERNAME?: string
  ADMIN_BOOTSTRAP_PASSWORD?: string
  ADMIN_SESSION_HOURS?: string
  TURNSTILE_SITE_KEY?: string
  TURNSTILE_SECRET_KEY?: string
  AUTH_RATE_LIMITER?: RateLimit
  INTERNAL_INGESTION_SECRET?: string
  GITHUB_WEBHOOK_SECRET?: string
}

export type ReleasePolicyTarget = {
  asset: string
  type?: UpdateActionType
  signatureAsset?: string
  label?: string
}

export type ReleasePolicy = {
  schemaVersion: 1
  minimumVersion?: string
  buildId?: string
  releaseNotes?: string
  rollout?: ReleaseManifest['rollout']
  targets?: Record<string, string | ReleasePolicyTarget>
}

export type UpdateCheckResponse = {
  currentVersion: string
  latestVersion: string
  minimumVersion: string
  currentBuildId: string | null
  latestBuildId: string | null
  updateAvailable: boolean
  mandatory: boolean
  eligible: boolean
  channel: string
  publishedAt: string
  releaseNotes: string
  action: ReleaseAction | null
}
