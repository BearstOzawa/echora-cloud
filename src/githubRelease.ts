import { isVersion } from './semver'
import type { ReleaseAction, ReleaseManifest, ReleasePolicy, ReleasePolicyTarget, UpdateActionType, WorkerEnv } from './types'

type GithubAsset = {
  name: string
  url: string
  browser_download_url: string
  size: number
  digest?: string | null
}

type GithubRelease = {
  tag_name: string
  html_url: string
  name?: string | null
  body?: string | null
  draft: boolean
  prerelease: boolean
  published_at?: string | null
  created_at: string
  assets: GithubAsset[]
}

const policyAssetName = 'echora-release.json'
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export class GithubReleaseError extends Error {}

const githubHeaders = (env: WorkerEnv, accept = 'application/vnd.github+json') => {
  const headers = new Headers({
    Accept: accept,
    'User-Agent': 'echora-update-worker',
    'X-GitHub-Api-Version': '2022-11-28',
  })
  if (env.GITHUB_TOKEN?.trim()) headers.set('Authorization', `Bearer ${env.GITHUB_TOKEN.trim()}`)
  return headers
}

const fetchGithubJson = async <T>(url: string, env: WorkerEnv): Promise<T> => {
  const response = await fetch(url, { headers: githubHeaders(env) })
  if (!response.ok) throw new GithubReleaseError(`GitHub release request failed with ${response.status}`)
  return response.json() as Promise<T>
}

const selectGithubRelease = async (env: WorkerEnv, repository: string, channel: string) => {
  const base = `https://api.github.com/repos/${repository}/releases`
  if (channel === 'stable') return fetchGithubJson<GithubRelease>(`${base}/latest`, env)
  const releases = await fetchGithubJson<GithubRelease[]>(`${base}?per_page=30`, env)
  const release = releases.find((candidate) => !candidate.draft && (channel === 'beta' ? candidate.prerelease : candidate.tag_name.includes(channel)))
  if (!release) throw new GithubReleaseError(`GitHub release channel ${channel} was not found`)
  return release
}

const readPolicy = async (release: GithubRelease, env: WorkerEnv): Promise<ReleasePolicy | null> => {
  const asset = release.assets.find((candidate) => candidate.name === policyAssetName)
  if (!asset) return null
  const response = await fetch(asset.url, { headers: githubHeaders(env, 'application/octet-stream'), redirect: 'follow' })
  if (!response.ok) throw new GithubReleaseError(`Release policy request failed with ${response.status}`)
  const value = await response.json() as ReleasePolicy
  if (value.schemaVersion !== 1) throw new GithubReleaseError('Release policy schema is not supported')
  return value
}

const assetArch = (name: string) => /(?:aarch64|arm64)/i.test(name) ? 'aarch64' : /(?:x86_64|x64|amd64)/i.test(name) ? 'x86_64' : 'universal'

const inferredTarget = (asset: GithubAsset, assets: GithubAsset[]) => {
  const name = asset.name
  const lower = name.toLocaleLowerCase()
  const arch = assetArch(name)
  if (lower.endsWith('.dmg')) return `desktop:darwin:${arch}`
  if (lower.endsWith('.exe') || lower.endsWith('.msi')) return `desktop:windows:${arch}`
  if (lower.endsWith('.appimage') || lower.endsWith('.deb')) return `desktop:linux:${arch}`
  if (lower.endsWith('.apk')) return `mobile:android:${arch}`
  if (lower.endsWith('.ipa')) return `mobile:ios:${arch}`
  if ((lower.endsWith('.app.tar.gz') || lower.endsWith('.nsis.zip')) && assets.some((candidate) => candidate.name === releaseSignatureName(name))) return `tauri:${tauriTargetFromAsset(name)}`
  return null
}

const releaseSignatureName = (assetName: string) => `${assetName}.sig`

const tauriTargetFromAsset = (name: string) => {
  const lower = name.toLocaleLowerCase()
  const os = lower.includes('windows') || lower.includes('nsis') ? 'windows' : lower.includes('linux') ? 'linux' : 'darwin'
  return `${os}-${assetArch(name)}`
}

const inferredType = (target: string): UpdateActionType => {
  if (target.startsWith('tauri:')) return 'tauri-update'
  if (target.startsWith('mobile:android')) return 'apk-download'
  if (target.startsWith('mobile:ios')) return 'ipa-download'
  if (target === 'web') return 'web-refresh'
  return 'github-release'
}

const normalizedPolicyTarget = (value: string | ReleasePolicyTarget): ReleasePolicyTarget => typeof value === 'string' ? { asset: value } : value

const mirrorUrl = (env: WorkerEnv, release: GithubRelease, asset: GithubAsset) => {
  const base = env.R2_DOWNLOAD_BASE_URL?.trim().replace(/\/$/, '')
  if (!base) return asset.browser_download_url
  return `${base}/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`
}

const signatureFor = async (signatureAsset: GithubAsset | undefined, env: WorkerEnv) => {
  if (!signatureAsset) return undefined
  const response = await fetch(signatureAsset.url, { headers: githubHeaders(env, 'application/octet-stream'), redirect: 'follow' })
  if (!response.ok) throw new GithubReleaseError(`Release signature request failed with ${response.status}`)
  return (await response.text()).trim()
}

const actionFromAsset = async (target: string, targetPolicy: ReleasePolicyTarget, release: GithubRelease, env: WorkerEnv): Promise<ReleaseAction | null> => {
  const asset = release.assets.find((candidate) => candidate.name === targetPolicy.asset)
  if (!asset) throw new GithubReleaseError(`Release asset ${targetPolicy.asset} was not found`)
  const type = targetPolicy.type ?? inferredType(target)
  const signatureAssetName = targetPolicy.signatureAsset ?? (type === 'tauri-update' ? releaseSignatureName(asset.name) : undefined)
  const signatureAsset = signatureAssetName ? release.assets.find((candidate) => candidate.name === signatureAssetName) : undefined
  if (type === 'tauri-update' && !signatureAsset) throw new GithubReleaseError(`Release signature ${signatureAssetName} was not found`)
  const githubUrl = asset.browser_download_url
  const url = mirrorUrl(env, release, asset)
  return {
    type,
    url,
    ...(url !== githubUrl ? { fallbackUrl: githubUrl } : {}),
    ...(targetPolicy.label ? { label: targetPolicy.label } : {}),
    ...(asset.digest?.startsWith('sha256:') ? { sha256: asset.digest.slice(7) } : {}),
    ...(type === 'tauri-update' ? { signature: await signatureFor(signatureAsset, env), tauriTarget: target.replace(/^tauri:/, '') } : {}),
    size: asset.size,
  }
}

const buildActions = async (release: GithubRelease, policy: ReleasePolicy | null, env: WorkerEnv) => {
  const targets: Record<string, ReleasePolicyTarget> = {}
  if (policy?.targets) {
    Object.entries(policy.targets).forEach(([target, value]) => { targets[target] = normalizedPolicyTarget(value) })
  } else {
    release.assets.forEach((asset) => {
      const target = inferredTarget(asset, release.assets)
      if (target && !targets[target]) targets[target] = { asset: asset.name }
    })
  }
  const entries = await Promise.all(Object.entries(targets).map(async ([target, targetPolicy]) => [target, await actionFromAsset(target, targetPolicy, release, env)] as const))
  const actions = Object.fromEntries(entries.filter((entry) => entry[1] !== null)) as Record<string, ReleaseAction>
  return actions
}

export const fetchGithubReleaseManifest = async (env: WorkerEnv, channel: string): Promise<ReleaseManifest> => {
  const repository = env.GITHUB_REPOSITORY?.trim() ?? ''
  if (!repositoryPattern.test(repository)) throw new GithubReleaseError('GITHUB_REPOSITORY must use owner/repository format')
  const release = await selectGithubRelease(env, repository, channel)
  const version = release.tag_name.replace(/^v/, '')
  if (!isVersion(version)) throw new GithubReleaseError(`GitHub release tag ${release.tag_name} is not semantic`)
  const policy = await readPolicy(release, env)
  const minimumVersion = policy?.minimumVersion ?? '0.0.0'
  if (!isVersion(minimumVersion)) throw new GithubReleaseError('Release minimumVersion is not semantic')
  return {
    schemaVersion: 1,
    version,
    minimumVersion,
    releaseUrl: release.html_url,
    buildId: policy?.buildId ?? release.tag_name,
    publishedAt: release.published_at ?? release.created_at,
    releaseNotes: policy?.releaseNotes?.trim() || release.body?.trim() || release.name?.trim() || '',
    ...(policy?.rollout ? { rollout: policy.rollout } : {}),
    actions: await buildActions(release, policy, env),
  }
}
