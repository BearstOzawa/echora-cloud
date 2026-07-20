import { checkRelease } from './release'
import { compareVersions, isVersion } from './semver'
import { GithubReleaseError, loadGithubRelease } from './githubRelease'
import type { ReleaseManifest, UpdatePlatform, WorkerEnv } from './types'

const allowedPlatforms = new Set<UpdatePlatform>(['web', 'desktop', 'mobile'])
const safeToken = /^[a-zA-Z0-9._-]{1,96}$/

const responseHeaders = (env: WorkerEnv) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN?.trim() || '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
})

const json = (env: WorkerEnv, body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: responseHeaders(env),
})

const loadRelease = async (env: WorkerEnv, channel: string, execution?: ExecutionContext) => {
  const githubRelease = await loadGithubRelease(env, channel, execution)
  if (githubRelease) return githubRelease
  if (!env.RELEASES) return null
  return env.RELEASES.get<ReleaseManifest>(`release:${channel}`, 'json')
}

const readToken = (url: URL, name: string, fallback = '') => {
  const value = url.searchParams.get(name)?.trim() || fallback
  if (!safeToken.test(value)) throw new Error(`${name} is invalid`)
  return value
}

const checkRequest = async (request: Request, env: WorkerEnv, execution?: ExecutionContext, overrides: Partial<Record<'platform' | 'os', string>> = {}) => {
  const url = new URL(request.url)
  const platform = (overrides.platform ?? readToken(url, 'platform')) as UpdatePlatform
  if (!allowedPlatforms.has(platform)) return json(env, { error: 'unsupported platform' }, 400)
  const os = overrides.os ?? readToken(url, 'os', platform === 'web' ? 'browser' : '')
  const arch = readToken(url, 'arch', platform === 'web' ? 'universal' : 'unknown')
  const currentVersion = readToken(url, 'current')
  if (!isVersion(currentVersion)) return json(env, { error: 'current must be a semantic version' }, 400)
  const channel = readToken(url, 'channel', 'stable')
  const installationId = readToken(url, 'installationId', 'anonymous')
  const currentBuildId = url.searchParams.get('buildId')?.trim() || null
  const manifest = await loadRelease(env, channel, execution)
  if (!manifest) return json(env, { error: 'release channel has not been published', channel }, 503)
  try {
    return json(env, checkRelease(manifest, { platform, os, arch, currentVersion, currentBuildId, channel, installationId }))
  } catch {
    return json(env, { error: 'published release manifest is invalid' }, 500)
  }
}

const tauriRequest = async (request: Request, env: WorkerEnv, execution: ExecutionContext | undefined, channel: string, target: string) => {
  if (!safeToken.test(channel) || !safeToken.test(target)) return json(env, { error: 'invalid updater route' }, 400)
  const url = new URL(request.url)
  const currentVersion = readToken(url, 'current')
  if (!isVersion(currentVersion)) return json(env, { error: 'current must be a semantic version' }, 400)
  const manifest = await loadRelease(env, channel, execution)
  if (!manifest) return json(env, { error: 'release channel has not been published', channel }, 503)
  if (compareVersions(manifest.version, currentVersion) <= 0) return new Response(null, { status: 204, headers: responseHeaders(env) })
  const action = Object.values(manifest.actions).find((candidate) => candidate.type === 'tauri-update' && candidate.tauriTarget === target)
  if (!action || !action.signature) return new Response(null, { status: 204, headers: responseHeaders(env) })
  return json(env, {
    version: manifest.version,
    notes: manifest.releaseNotes,
    pub_date: manifest.publishedAt,
    url: action.url,
    signature: action.signature,
  })
}

const releaseCatalogRequest = async (request: Request, env: WorkerEnv, execution?: ExecutionContext) => {
  const url = new URL(request.url)
  const channel = readToken(url, 'channel', 'stable')
  const manifest = await loadRelease(env, channel, execution)
  if (!manifest) return json(env, { error: 'release channel has not been published', channel }, 503)
  return json(env, {
    version: manifest.version,
    channel,
    publishedAt: manifest.publishedAt,
    releaseNotes: manifest.releaseNotes,
    releaseUrl: manifest.releaseUrl,
    downloads: Object.entries(manifest.actions)
      .filter(([, action]) => action.type !== 'tauri-update')
      .map(([target, action]) => ({ target, ...action })),
  })
}

export default {
  async fetch(request: Request, env: WorkerEnv, execution?: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders(env) })
    if (request.method !== 'GET') return json(env, { error: 'method not allowed' }, 405)
    const url = new URL(request.url)
    if (url.pathname === '/health') return json(env, { ok: true, service: 'echora-cloud' })
    if (url.pathname === '/help/install/ios') return Response.redirect(new URL('/download', url), 308)
    try {
      if (url.pathname === '/v1/releases/latest') return await releaseCatalogRequest(request, env, execution)
      if (url.pathname === '/v1/check') return await checkRequest(request, env, execution)
      if (url.pathname === '/v1/web') return await checkRequest(request, env, execution, { platform: 'web', os: 'browser' })
      if (url.pathname === '/v1/mobile/android') return await checkRequest(request, env, execution, { platform: 'mobile', os: 'android' })
      if (url.pathname === '/v1/mobile/ios') return await checkRequest(request, env, execution, { platform: 'mobile', os: 'ios' })
      const tauriMatch = url.pathname.match(/^\/v1\/tauri\/([^/]+)\/([^/]+)$/)
      if (tauriMatch) return await tauriRequest(request, env, execution, decodeURIComponent(tauriMatch[1]), decodeURIComponent(tauriMatch[2]))
      return env.ASSETS ? env.ASSETS.fetch(request) : json(env, { error: 'not found' }, 404)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid request'
      return json(env, { error: message }, error instanceof GithubReleaseError ? 502 : 400)
    }
  },
}
