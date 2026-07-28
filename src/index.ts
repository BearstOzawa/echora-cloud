import { checkRelease } from './release'
import { compareVersions, isVersion } from './semver'
import type { UpdatePlatform, WorkerEnv } from './types'
import { changePassword, cleanupDeletedAccounts, listDevices, login, logout, me, register, requestDeletion, resetPasswordWithRecovery, restoreAccount, revokeDevice, updateProfile } from './auth'
import { adminLogin, adminLogout, adminMe, changeAdminPassword } from './adminAuth'
import { aiStatus, customAiRequest, managedAiRequest } from './ai'
import { adminAudit, adminConfig, adminMusicHealth, adminOverview, adminUserAction, adminUsers, bootstrap } from './admin'
import { corsHeaders, errorResponse } from './http'
import { handleMusicRequest } from './music'
import { deleteCredential, getCredential, pullChanges, pushChanges, putCredential } from './sync'
import { cleanupAuthRisk } from './turnstile'
import { adminGithubSync, adminReleaseAction, adminVersions, githubReleaseWebhook, loadPublishedRelease, parseProduct, productForRequest, publicProductVersions, reconcileGithubReleases, registerDeployment } from './versionRegistry'
import { cleanupMusicProviderHealth } from './musicHealth'

const allowedPlatforms = new Set<UpdatePlatform>(['web', 'desktop', 'mobile'])
const safeToken = /^[a-zA-Z0-9._-]{1,96}$/

const responseHeaders = (request: Request, env: WorkerEnv) => ({
  ...corsHeaders(request, env),
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
})

const json = (request: Request, env: WorkerEnv, body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: responseHeaders(request, env),
})

const readToken = (url: URL, name: string, fallback = '') => {
  const value = url.searchParams.get(name)?.trim() || fallback
  if (!safeToken.test(value)) throw new Error(`${name} is invalid`)
  return value
}

const checkRequest = async (request: Request, env: WorkerEnv, overrides: Partial<Record<'platform' | 'os', string>> = {}) => {
  const url = new URL(request.url)
  const platform = (overrides.platform ?? readToken(url, 'platform')) as UpdatePlatform
  if (!allowedPlatforms.has(platform)) return json(request, env, { error: 'unsupported platform' }, 400)
  const os = overrides.os ?? readToken(url, 'os', platform === 'web' ? 'browser' : '')
  const arch = readToken(url, 'arch', platform === 'web' ? 'universal' : 'unknown')
  const currentVersion = readToken(url, 'current')
  if (!isVersion(currentVersion)) return json(request, env, { error: 'current must be a semantic version' }, 400)
  const channel = readToken(url, 'channel', 'stable')
  const installationId = readToken(url, 'installationId', 'anonymous')
  const currentBuildId = url.searchParams.get('buildId')?.trim() || null
  const product = parseProduct(url.searchParams.get('product'), productForRequest(platform, os))
  const manifest = await loadPublishedRelease(env, product, channel)
  if (!manifest) return json(request, env, { error: 'release channel has not been published' }, 503)
  try {
    return json(request, env, checkRelease(manifest, { platform, os, arch, currentVersion, currentBuildId, channel, installationId }))
  } catch {
    return json(request, env, { error: 'published release manifest is invalid' }, 500)
  }
}

const tauriRequest = async (request: Request, env: WorkerEnv, channel: string, target: string) => {
  if (!safeToken.test(channel) || !safeToken.test(target)) return json(request, env, { error: 'invalid updater route' }, 400)
  const url = new URL(request.url)
  const currentVersion = readToken(url, 'current')
  if (!isVersion(currentVersion)) return json(request, env, { error: 'current must be a semantic version' }, 400)
  const manifest = await loadPublishedRelease(env, 'echora-desktop', channel)
  if (!manifest) return json(request, env, { error: 'release channel has not been published', channel }, 503)
  if (compareVersions(manifest.version, currentVersion) <= 0) return new Response(null, { status: 204, headers: responseHeaders(request, env) })
  const action = Object.values(manifest.actions).find((candidate) => candidate.type === 'tauri-update' && candidate.tauriTarget === target)
  if (!action || !action.signature) return new Response(null, { status: 204, headers: responseHeaders(request, env) })
  return json(request, env, {
    version: manifest.version,
    notes: manifest.releaseNotes,
    pub_date: manifest.publishedAt,
    url: action.url,
    signature: action.signature,
  })
}

const releaseCatalogRequest = async (request: Request, env: WorkerEnv) => {
  const url = new URL(request.url)
  const channel = readToken(url, 'channel', 'stable')
  const requestedProduct = url.searchParams.get('product')
  const products = requestedProduct
    ? [parseProduct(requestedProduct)]
    : ['echora-desktop', 'echora-android', 'echora-ios', 'echora-web'] as const
  const manifests = (await Promise.all(products.map(async (product) => ({ product, manifest: await loadPublishedRelease(env, product, channel) })))).filter((entry) => entry.manifest)
  if (!manifests.length) return json(request, env, { error: 'release channel has not been published', channel }, 503)
  const primary = manifests[0].manifest!
  const downloads = new Map<string, Record<string, unknown>>()
  manifests.forEach(({ product, manifest }) => Object.entries(manifest!.actions).forEach(([target, action]) => {
    if (action.type !== 'tauri-update' && !downloads.has(target)) downloads.set(target, { target, product, ...action })
  }))
  return json(request, env, {
    version: primary.version,
    channel,
    publishedAt: primary.publishedAt,
    releaseNotes: primary.releaseNotes,
    releaseUrl: primary.releaseUrl,
    downloads: [...downloads.values()],
  })
}

export default {
  async fetch(request: Request, env: WorkerEnv, execution?: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) })
    const url = new URL(request.url)
    if (url.pathname === '/health') return json(request, env, { ok: true, service: 'echora-cloud' })
    if (url.pathname === '/help/install/ios') return Response.redirect(new URL('/download', url), 308)
    try {
      if (request.method === 'GET' && url.pathname === '/v1/bootstrap') return await bootstrap(request, env)
      if (request.method === 'POST' && url.pathname === '/v1/admin/auth/login') return await adminLogin(request, env)
      if (request.method === 'POST' && url.pathname === '/v1/admin/auth/logout') return await adminLogout(request, env)
      if (request.method === 'GET' && url.pathname === '/v1/admin/me') return await adminMe(request, env)
      if (request.method === 'PUT' && url.pathname === '/v1/admin/me/password') return await changeAdminPassword(request, env)
      if (request.method === 'POST' && url.pathname === '/v1/auth/register') return await register(request, env)
      if (request.method === 'POST' && url.pathname === '/v1/auth/login') return await login(request, env)
      if (request.method === 'POST' && url.pathname === '/v1/auth/recover') return await resetPasswordWithRecovery(request, env)
      if (request.method === 'POST' && url.pathname === '/v1/auth/restore') return await restoreAccount(request, env)
      if (request.method === 'POST' && url.pathname === '/v1/auth/logout') return await logout(request, env)
      if (request.method === 'GET' && url.pathname === '/v1/me') return await me(request, env)
      if (request.method === 'PUT' && url.pathname === '/v1/me') return await updateProfile(request, env)
      if (request.method === 'PUT' && url.pathname === '/v1/me/password') return await changePassword(request, env)
      if (request.method === 'GET' && url.pathname === '/v1/me/devices') return await listDevices(request, env)
      const deviceMatch = url.pathname.match(/^\/v1\/me\/devices\/([^/]+)$/)
      if (request.method === 'DELETE' && deviceMatch) return await revokeDevice(request, env, decodeURIComponent(deviceMatch[1]))
      if (request.method === 'POST' && url.pathname === '/v1/me/deletion') return await requestDeletion(request, env)
      if (request.method === 'GET' && url.pathname === '/v1/sync') return await pullChanges(request, env)
      if (request.method === 'POST' && url.pathname === '/v1/sync') return await pushChanges(request, env)
      if (request.method === 'GET' && url.pathname === '/v1/me/credentials/custom-ai') return await getCredential(request, env)
      if (request.method === 'PUT' && url.pathname === '/v1/me/credentials/custom-ai') return await putCredential(request, env)
      if (request.method === 'DELETE' && url.pathname === '/v1/me/credentials/custom-ai') return await deleteCredential(request, env)
      if (url.pathname.startsWith('/v1/music/')) return await handleMusicRequest(request, env, execution)
      if (request.method === 'GET' && url.pathname === '/v1/ai/status') return await aiStatus(request, env)
      if (request.method === 'POST' && url.pathname === '/v1/ai/request') return await managedAiRequest(request, env)
      if (request.method === 'POST' && url.pathname === '/v1/ai/custom/request') return await customAiRequest(request, env)
      if (url.pathname === '/v1/admin/config' && (request.method === 'GET' || request.method === 'PUT')) return await adminConfig(request, env)
      if (request.method === 'GET' && url.pathname === '/v1/admin/overview') return await adminOverview(request, env)
      if (request.method === 'GET' && url.pathname === '/v1/admin/music/health') return await adminMusicHealth(request, env)
      if (request.method === 'GET' && url.pathname === '/v1/admin/audit') return await adminAudit(request, env)
      if (request.method === 'GET' && url.pathname === '/v1/admin/users') return await adminUsers(request, env)
      const adminUserMatch = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)$/)
      if (request.method === 'POST' && adminUserMatch) return await adminUserAction(request, env, decodeURIComponent(adminUserMatch[1]))
      if (request.method === 'GET' && url.pathname === '/v1/admin/versions') return await adminVersions(request, env)
      if (request.method === 'POST' && url.pathname === '/v1/admin/versions/github-sync') return await adminGithubSync(request, env)
      const adminReleaseMatch = url.pathname.match(/^\/v1\/admin\/versions\/releases\/(.+)$/)
      if (request.method === 'POST' && adminReleaseMatch) return await adminReleaseAction(request, env, decodeURIComponent(adminReleaseMatch[1]))
      if (request.method === 'POST' && url.pathname === '/v1/internal/deployments') return await registerDeployment(request, env)
      if (request.method === 'POST' && url.pathname === '/v1/internal/releases/github') return await githubReleaseWebhook(request, env)
      if (request.method !== 'GET') return json(request, env, { error: 'method not allowed' }, 405)
      if (url.pathname === '/v1/products/versions') return await publicProductVersions(request, env)
      if (url.pathname === '/v1/releases/latest') return await releaseCatalogRequest(request, env)
      if (url.pathname === '/v1/check') return await checkRequest(request, env)
      if (url.pathname === '/v1/web') return await checkRequest(request, env, { platform: 'web', os: 'browser' })
      if (url.pathname === '/v1/mobile/android') return await checkRequest(request, env, { platform: 'mobile', os: 'android' })
      if (url.pathname === '/v1/mobile/ios') return await checkRequest(request, env, { platform: 'mobile', os: 'ios' })
      const tauriMatch = url.pathname.match(/^\/v1\/tauri\/([^/]+)\/([^/]+)$/)
      if (tauriMatch) return await tauriRequest(request, env, decodeURIComponent(tauriMatch[1]), decodeURIComponent(tauriMatch[2]))
      return env.ASSETS ? env.ASSETS.fetch(request) : json(request, env, { error: 'not found' }, 404)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid request'
      return errorResponse(request, env, error)
    }
  },
  async scheduled(_controller: ScheduledController, env: WorkerEnv): Promise<void> {
    await Promise.all([cleanupDeletedAccounts(env), cleanupAuthRisk(env), cleanupMusicProviderHealth(env), reconcileGithubReleases(env)])
  },
}
