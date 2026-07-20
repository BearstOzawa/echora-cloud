export type UpdatePlatform = 'web' | 'desktop' | 'mobile'
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
  ASSETS?: Fetcher
  ALLOWED_ORIGIN?: string
  GITHUB_REPOSITORY?: string
  GITHUB_TOKEN?: string
  GITHUB_CACHE_SECONDS?: string
  R2_DOWNLOAD_BASE_URL?: string
  WEB_APP_URL?: string
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
