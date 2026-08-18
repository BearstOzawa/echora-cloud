import { isVersion } from './semver'
import type { ReleaseAction, ReleaseManifest, ReleasePolicy, ReleasePolicyTarget, UpdateActionType, WorkerEnv } from './types'

type GithubAsset = {
  id: number
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

export type GithubReleaseOptions = {
  includeDrafts?: boolean
}

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
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new GithubReleaseError(env.GITHUB_TOKEN?.trim()
        ? 'GitHub 凭据无效或无权读取 Release'
        : 'GitHub API 暂时拒绝了未认证请求')
    }
    if (response.status === 404) throw new GithubReleaseError('GitHub 仓库或 Release 不可访问')
    throw new GithubReleaseError(`GitHub Release 请求失败（HTTP ${response.status}）`)
  }
  return response.json() as Promise<T>
}

const selectGithubRelease = async (env: WorkerEnv, repository: string, channel: string, options: GithubReleaseOptions) => {
  const base = `https://api.github.com/repos/${repository}/releases`
  if (channel === 'stable' && !options.includeDrafts) return fetchGithubJson<GithubRelease>(`${base}/latest`, env)
  const releases = await fetchGithubJson<GithubRelease[]>(`${base}?per_page=30`, env)
  const release = releases.find((candidate) => (options.includeDrafts || !candidate.draft)
    && (channel === 'stable' ? !candidate.prerelease : channel === 'beta' ? candidate.prerelease : candidate.tag_name.includes(channel)))
  if (!release && options.includeDrafts && !env.GITHUB_TOKEN?.trim()) {
    throw new GithubReleaseError('未找到可同步的公开 Release。如果目标版本仍是 GitHub 草稿，请先发布，或为 Echora Cloud 配置 GITHUB_TOKEN 后重试')
  }
  if (!release) throw new GithubReleaseError(`GitHub 中没有可同步的 ${channel} Release`)
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
  if (release.draft) {
    const base = env.PUBLIC_CLOUD_URL?.trim().replace(/\/$/, '')
    if (!base) throw new GithubReleaseError('PUBLIC_CLOUD_URL must be configured before importing a draft Release')
    return `${base}/v1/releases/assets/${asset.id}/${encodeURIComponent(asset.name)}`
  }
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
    ...(url !== githubUrl && !release.draft ? { fallbackUrl: githubUrl } : {}),
    ...(targetPolicy.label ? { label: targetPolicy.label } : {}),
    ...(asset.digest?.startsWith('sha256:') ? { sha256: asset.digest.slice(7) } : {}),
    ...(type === 'tauri-update' ? { signature: await signatureFor(signatureAsset, env), tauriTarget: target.replace(/^tauri:/, '') } : {}),
    size: asset.size,
  }
}

export const proxyGithubReleaseAsset = async (request: Request, env: WorkerEnv, assetIdValue: string, requestedName: string) => {
  const unavailable = (code: string, status = 502) => new Response('Release download unavailable', {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Echora-Download-Error': code },
  })
  const repository = env.GITHUB_REPOSITORY?.trim() ?? ''
  if (!repositoryPattern.test(repository)) return new Response('Release source unavailable', { status: 503 })
  if (!env.GITHUB_TOKEN?.trim()) return new Response('Release source unavailable', { status: 503 })
  if (!/^\d{1,20}$/.test(assetIdValue)) return new Response('Release asset not found', { status: 404 })

  if (env.DB) {
    const routeSuffix = `/v1/releases/assets/${assetIdValue}/${encodeURIComponent(requestedName)}`
    const publicBase = env.PUBLIC_CLOUD_URL!.trim().replace(/\/$/, '')
    let published: unknown
    try {
      published = await env.DB.prepare(`SELECT 1 AS available FROM version_artifacts a
          JOIN version_releases r ON r.id = a.release_id
          WHERE r.status = 'published' AND a.url = ? LIMIT 1`).bind(`${publicBase}${routeSuffix}`).first()
    } catch {
      return unavailable('release_registry_query', 503)
    }
    if (!published) return new Response('Release asset not found', { status: 404, headers: { 'X-Echora-Download-Error': 'release_not_published' } })
  }

  const apiUrl = `https://api.github.com/repos/${repository}/releases/assets/${assetIdValue}`
  const metadataResponse = await fetch(apiUrl, { headers: githubHeaders(env) }).catch(() => null)
  if (!metadataResponse) return unavailable('github_metadata_request')
  if (!metadataResponse.ok) return new Response('Release asset not found', { status: metadataResponse.status === 404 ? 404 : 502, headers: { 'X-Echora-Download-Error': `github_metadata_${metadataResponse.status}` } })
  const asset = await metadataResponse.json().catch(() => null) as GithubAsset | null
  if (!asset) return unavailable('github_metadata_payload')
  if (asset.name !== requestedName) return new Response('Release asset not found', { status: 404, headers: { 'X-Echora-Download-Error': 'asset_name_mismatch' } })

  const githubDownload = await fetch(apiUrl, { headers: githubHeaders(env, 'application/octet-stream'), redirect: 'manual' }).catch(() => null)
  if (!githubDownload) return unavailable('github_asset_request')
  const redirectUrl = githubDownload.headers.get('Location')
  const requestedRange = request.headers.get('Range')
  const download = githubDownload.status >= 300 && githubDownload.status < 400 && redirectUrl
    ? await fetch(redirectUrl, { headers: requestedRange ? { Range: requestedRange } : undefined, redirect: 'follow' }).catch(() => null)
    : githubDownload
  if (!download) return unavailable('github_asset_redirect')
  if (!download.ok || !download.body) return new Response('Release download unavailable', { status: 502 })
  const headers = new Headers({
    'Cache-Control': 'private, max-age=300',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
    'Content-Type': download.headers.get('Content-Type') || 'application/octet-stream',
  })
  const contentLength = download.headers.get('Content-Length')
  if (contentLength) headers.set('Content-Length', contentLength)
  const contentRange = download.headers.get('Content-Range')
  if (contentRange) headers.set('Content-Range', contentRange)
  const acceptRanges = download.headers.get('Accept-Ranges')
  if (acceptRanges) headers.set('Accept-Ranges', acceptRanges)
  try {
    return new Response(download.body, { status: download.status, headers })
  } catch {
    return unavailable('response_stream')
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

export const fetchGithubReleaseManifest = async (env: WorkerEnv, channel: string, options: GithubReleaseOptions = {}): Promise<ReleaseManifest> => {
  const repository = env.GITHUB_REPOSITORY?.trim() ?? ''
  if (!repositoryPattern.test(repository)) throw new GithubReleaseError('GITHUB_REPOSITORY must use owner/repository format')
  const release = await selectGithubRelease(env, repository, channel, options)
  const version = release.tag_name.replace(/^v/, '')
  if (!isVersion(version)) throw new GithubReleaseError(`GitHub release tag ${release.tag_name} is not semantic`)
  const policy = await readPolicy(release, env)
  const minimumVersion = policy?.minimumVersion ?? '0.0.0'
  if (!isVersion(minimumVersion)) throw new GithubReleaseError('Release minimumVersion is not semantic')
  return {
    schemaVersion: 1,
    version,
    minimumVersion,
    ...(!release.draft ? { releaseUrl: release.html_url } : {}),
    buildId: policy?.buildId ?? release.tag_name,
    publishedAt: release.published_at ?? release.created_at,
    releaseNotes: policy?.releaseNotes?.trim() || release.body?.trim() || release.name?.trim() || '',
    ...(policy?.rollout ? { rollout: policy.rollout } : {}),
    actions: await buildActions(release, policy, env),
  }
}
