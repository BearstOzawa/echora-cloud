import { compareVersions } from './semver'
import type { ReleaseAction, ReleaseManifest, UpdateCheckResponse, UpdatePlatform } from './types'

export type CheckInput = {
  platform: UpdatePlatform
  os: string
  arch: string
  currentVersion: string
  currentBuildId: string | null
  channel: string
  installationId: string
}

const stableHash = (value: string) => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export const isRolloutEligible = (manifest: ReleaseManifest, installationId: string) => {
  const percentage = Math.max(0, Math.min(100, manifest.rollout?.percentage ?? 100))
  if (percentage === 100) return true
  if (percentage === 0 || !installationId) return false
  const bucket = stableHash(`${manifest.rollout?.salt ?? manifest.version}:${installationId}`) % 10_000
  return bucket < percentage * 100
}

export const actionFor = (manifest: ReleaseManifest, input: Pick<CheckInput, 'platform' | 'os' | 'arch'>): ReleaseAction | null => {
  const keys = [
    `${input.platform}:${input.os}:${input.arch}`,
    `${input.platform}:${input.os}:universal`,
    `${input.platform}:${input.os}`,
    input.platform,
  ]
  for (const key of keys) {
    if (manifest.actions[key]) return manifest.actions[key]
  }
  return null
}

export const checkRelease = (manifest: ReleaseManifest, input: CheckInput): UpdateCheckResponse => {
  const versionUpdate = compareVersions(manifest.version, input.currentVersion) > 0
  const webBuildUpdate = input.platform === 'web'
    && manifest.version === input.currentVersion
    && Boolean(manifest.buildId && input.currentBuildId && manifest.buildId !== input.currentBuildId)
  const mandatory = compareVersions(input.currentVersion, manifest.minimumVersion) < 0
  const eligible = mandatory || isRolloutEligible(manifest, input.installationId)
  const action = actionFor(manifest, input)
  const updateAvailable = Boolean(action && eligible && (versionUpdate || webBuildUpdate || mandatory))
  return {
    currentVersion: input.currentVersion,
    latestVersion: manifest.version,
    minimumVersion: manifest.minimumVersion,
    currentBuildId: input.currentBuildId,
    latestBuildId: manifest.buildId ?? null,
    updateAvailable,
    mandatory,
    eligible,
    channel: input.channel,
    publishedAt: manifest.publishedAt,
    releaseNotes: manifest.releaseNotes,
    action: updateAvailable ? action : null,
  }
}
