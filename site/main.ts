import { Activity, ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, BadgeCheck, CalendarDays, Check, ChevronLeft, ChevronRight, Copy, Download, Globe2, GripVertical, LayoutDashboard, ListChecks, LogOut, Monitor, MonitorDown, Music2, PackageOpen, Play, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Smartphone, Sparkles, Users, X, createIcons } from 'lucide'
import './site.css'

type DownloadAction = {
  target: string
  type: 'web-refresh' | 'github-release' | 'apk-download' | 'ipa-download'
  url: string
  fallbackUrl?: string
  label?: string
  sha256?: string
  size?: number
}

type ReleaseCatalog = {
  version: string
  channel: string
  publishedAt: string
  releaseNotes: string
  releaseUrl?: string
  downloads: DownloadAction[]
}

const icons = { Activity, ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, BadgeCheck, CalendarDays, Check, ChevronLeft, ChevronRight, Copy, Download, Globe2, GripVertical, LayoutDashboard, ListChecks, LogOut, Monitor, MonitorDown, Music2, PackageOpen, Play, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Smartphone, Sparkles, Users, X }
createIcons({ icons })

const officialWebUrl = (import.meta.env.VITE_ECHORA_WEB_URL || 'https://echora-web.lili.uno').replace(/\/$/, '')
document.querySelectorAll<HTMLAnchorElement>('[data-web-app-link]').forEach((link) => { link.href = `${officialWebUrl}/` })

const platformDefinitions = {
  darwin: { label: 'macOS', icon: 'monitor', detail: '适用于 Mac' },
  windows: { label: 'Windows', icon: 'monitor', detail: '适用于 Windows 电脑' },
  linux: { label: 'Linux', icon: 'monitor', detail: 'AppImage 或安装包' },
  android: { label: 'Android', icon: 'smartphone', detail: '签名 APK' },
  ios: { label: 'iOS', icon: 'smartphone', detail: '签名 IPA' },
  web: { label: 'Web 版', icon: 'globe-2', detail: '在浏览器中使用' },
} as const

type PlatformKey = keyof typeof platformDefinitions

const routeForPath = () => {
  if (location.pathname.startsWith('/challenge')) return 'challenge'
  if (location.pathname.startsWith('/admin')) return 'admin'
  if (location.pathname.startsWith('/account')) return 'account'
  if (location.pathname.startsWith('/privacy')) return 'privacy'
  if (location.pathname.startsWith('/product')) return 'product'
  if (location.pathname.startsWith('/releases')) return 'releases'
  if (location.pathname.startsWith('/download')) return 'download'
  return 'home'
}

const activeRoute = routeForPath()
document.documentElement.dataset.route = activeRoute
const routeTitles: Record<string, string> = {
  home: 'Echora - 智能音乐工作空间',
  product: 'Echora 产品 - 发现、编排与聆听',
  download: '下载 Echora',
  releases: 'Echora 版本与更新',
  privacy: 'Echora 隐私说明',
  account: 'Echora 账户中心',
  admin: 'Echora 系统管理',
  challenge: 'Echora 安全验证',
}
document.title = routeTitles[activeRoute]
document.querySelectorAll<HTMLElement>('[data-view]').forEach((view) => { view.hidden = view.dataset.view !== activeRoute })
document.querySelectorAll<HTMLAnchorElement>('.site-header nav a, footer nav a').forEach((link) => {
  if (link.pathname === location.pathname) link.setAttribute('aria-current', 'page')
})

type CloudUser = { id: string; username: string; displayName: string; avatarUrl: string | null; createdAt: number }
type CloudSession = { token: string; user: CloudUser }
type CloudDevice = { id: string; deviceId: string; name: string; createdAt: number; lastSeenAt: number; expiresAt: number; current: boolean }
type AdminIdentity = { id: string; username: string; displayName: string; createdAt: number }
type TurnstileChallenge = { provider: 'turnstile'; siteKey: string; action: string }

const cloudSessionKey = 'echora.cloudSession.v1'
const installationKey = 'echora.installationId'
const readSession = (): CloudSession | null => {
  try {
    const session = JSON.parse(localStorage.getItem(cloudSessionKey) || 'null') as CloudSession | null
    return session?.token && session.user?.id ? session : null
  } catch {
    return null
  }
}
const renderAccountNavigation = (session: CloudSession | null) => {
  const link = document.querySelector<HTMLElement>('[data-account-nav]')
  const avatar = link?.querySelector<HTMLElement>('[data-account-nav-avatar]')
  const label = link?.querySelector<HTMLElement>('[data-account-nav-label]')
  if (!link || !avatar || !label) return
  link.classList.toggle('is-authenticated', Boolean(session))
  avatar.hidden = !session
  avatar.textContent = session?.user.displayName.slice(0, 1).toLocaleUpperCase() || 'E'
  label.textContent = session?.user.displayName || '账户'
  link.title = session ? `@${session.user.username}` : 'Echora 账户'
}
const writeSession = (session: CloudSession | null) => {
  if (session) localStorage.setItem(cloudSessionKey, JSON.stringify(session))
  else localStorage.removeItem(cloudSessionKey)
  renderAccountNavigation(session)
}
const installationId = () => {
  const existing = localStorage.getItem(installationKey)
  if (existing) return existing
  const value = crypto.randomUUID()
  localStorage.setItem(installationKey, value)
  return value
}

class WebsiteApiError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'request_failed', readonly detail: Record<string, unknown> = {}) { super(message) }
}

const cloudRequest = async <T>(path: string, init: RequestInit = {}, authenticated = false): Promise<T> => {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  headers.set('X-Echora-Device', installationId())
  headers.set('X-Echora-Device-Name', 'Echora Cloud')
  if (init.body) headers.set('Content-Type', 'application/json')
  const session = readSession()
  if (authenticated && !session) throw new WebsiteApiError(401, '请先登录')
  if (session) headers.set('Authorization', `Bearer ${session.token}`)
  let response: Response
  try {
    response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  } catch {
    throw new WebsiteApiError(0, '暂时无法连接 Echora Cloud')
  }
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => ({})) as { message?: string; error?: string } & T
  if (!response.ok) {
    if (response.status === 401 && session) writeSession(null)
    throw new WebsiteApiError(response.status, data.message || data.error || '请求未完成', data.error, data as Record<string, unknown>)
  }
  return data
}

const adminRequest = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body) headers.set('Content-Type', 'application/json')
  let response: Response
  try { response = await fetch(path, { ...init, headers, credentials: 'same-origin' }) }
  catch { throw new WebsiteApiError(0, '暂时无法连接 Echora Cloud') }
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => ({})) as { message?: string; error?: string } & T
  if (!response.ok) throw new WebsiteApiError(response.status, data.message || data.error || '请求未完成', data.error, data as Record<string, unknown>)
  return data
}

type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string
  remove: (widgetId: string) => void
}

declare global { interface Window { turnstile?: TurnstileApi } }

let turnstileLoader: Promise<TurnstileApi> | null = null
const loadTurnstile = () => {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (turnstileLoader) return turnstileLoader
  turnstileLoader = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.defer = true
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('验证服务未能初始化'))
    script.onerror = () => reject(new Error('验证服务暂时不可用'))
    document.head.append(script)
  })
  return turnstileLoader
}

const completeTurnstile = async (container: HTMLElement, challenge: TurnstileChallenge) => {
  const turnstile = await loadTurnstile()
  container.dataset.active = 'true'
  return new Promise<string>((resolve, reject) => {
    let widgetId = ''
    const finish = (callback: () => void) => {
      if (widgetId) turnstile.remove(widgetId)
      container.replaceChildren()
      delete container.dataset.active
      callback()
    }
    widgetId = turnstile.render(container, {
      sitekey: challenge.siteKey,
      action: challenge.action,
      appearance: 'always',
      execution: 'render',
      size: 'flexible',
      theme: 'auto',
      callback: (token: string) => finish(() => resolve(token)),
      'error-callback': () => finish(() => reject(new Error('验证未完成，请重试'))),
      'expired-callback': () => finish(() => reject(new Error('验证已过期，请重试'))),
    })
  })
}

const challengeFor = (error: unknown) => error instanceof WebsiteApiError && error.code === 'challenge_required'
  ? error.detail.challenge as TurnstileChallenge | undefined
  : undefined

const requestWithChallenge = async <T>(request: (turnstileToken?: string) => Promise<T>, container: HTMLElement) => {
  try { return await request() } catch (error) {
    const challenge = challengeFor(error)
    if (!challenge?.siteKey) throw error
    const token = await completeTurnstile(container, challenge)
    return request(token)
  }
}

const setupChallengeView = async () => {
  if (activeRoute !== 'challenge') return
  const container = document.querySelector<HTMLElement>('[data-challenge-turnstile]')
  const status = document.querySelector<HTMLElement>('[data-challenge-status]')
  if (!container || !status) return
  const parameters = new URLSearchParams(location.search)
  const siteKey = parameters.get('siteKey') || ''
  const action = parameters.get('action') || ''
  const nonce = parameters.get('nonce') || ''
  const allowedActions = new Set(['register', 'login', 'recover', 'restore'])
  if (!siteKey || !allowedActions.has(action) || !nonce || nonce.length > 128 || window.parent === window) {
    status.textContent = '验证请求无效'
    status.dataset.tone = 'error'
    return
  }
  try {
    const turnstile = await loadTurnstile()
    container.dataset.active = 'true'
    turnstile.render(container, {
      sitekey: siteKey,
      action,
      appearance: 'always',
      execution: 'render',
      size: 'flexible',
      theme: 'auto',
      callback: (token: string) => {
        status.textContent = '验证完成'
        window.parent.postMessage({ type: 'echora:turnstile', nonce, action, token }, '*')
      },
      'error-callback': () => {
        status.textContent = '验证未完成，请重试'
        status.dataset.tone = 'error'
        window.parent.postMessage({ type: 'echora:turnstile-error', nonce, action }, '*')
      },
      'expired-callback': () => {
        status.textContent = '验证已过期，请重试'
        status.dataset.tone = 'error'
      },
    })
    status.textContent = '请完成安全验证'
  } catch {
    status.textContent = '验证服务暂时不可用'
    status.dataset.tone = 'error'
    window.parent.postMessage({ type: 'echora:turnstile-error', nonce, action }, '*')
  }
}

const setupAccountNavigation = async () => {
  const session = readSession()
  renderAccountNavigation(session)
  if (!session) return
  try {
    const { user } = await cloudRequest<{ user: CloudUser }>('/v1/me', {}, true)
    writeSession({ ...session, user })
  } catch (error) {
    if (error instanceof WebsiteApiError && error.status === 401) writeSession(null)
  }
}

const setStateMessage = (element: HTMLElement | null, message = '', tone: 'idle' | 'success' | 'error' = 'idle') => {
  if (!element) return
  element.textContent = message
  element.dataset.tone = tone
  element.hidden = !message
}

const setupAccountCenter = () => {
  if (activeRoute !== 'account') return
  const auth = document.querySelector<HTMLElement>('[data-account-auth]')
  const dashboard = document.querySelector<HTMLElement>('[data-account-dashboard]')
  const form = document.querySelector<HTMLFormElement>('[data-account-form]')
  const profileForm = document.querySelector<HTMLFormElement>('[data-profile-form]')
  const passwordForm = document.querySelector<HTMLFormElement>('[data-password-form]')
  const deleteForm = document.querySelector<HTMLFormElement>('[data-delete-form]')
  const status = document.querySelector<HTMLElement>('[data-account-status]')
  const editor = document.querySelector<HTMLElement>('[data-account-editor]')
  const editorTitle = document.querySelector<HTMLElement>('[data-account-editor-title]')
  const editorStatus = document.querySelector<HTMLElement>('[data-account-editor-status]')
  const result = document.querySelector<HTMLElement>('[data-recovery-result]')
  const turnstileSlot = document.querySelector<HTMLElement>('[data-account-turnstile]')
  const back = document.querySelector<HTMLButtonElement>('[data-account-back]')
  const authLinks = document.querySelector<HTMLElement>('[data-account-auth-links]')
  if (!auth || !dashboard || !form || !profileForm || !passwordForm || !deleteForm || !editor || !result || !turnstileSlot) return
  let mode: 'login' | 'register' | 'recover' | 'restore' = 'login'
  const resetAccountScroll = () => scrollTo({ top: 0, behavior: 'auto' })

  const closeEditor = () => {
    editor.hidden = true
    profileForm.hidden = true
    passwordForm.hidden = true
    passwordForm.reset()
    setStateMessage(editorStatus)
  }

  const openEditor = (kind: 'profile' | 'password') => {
    const session = readSession()
    if (!session) return
    editor.hidden = false
    profileForm.hidden = kind !== 'profile'
    passwordForm.hidden = kind !== 'password'
    if (editorTitle) editorTitle.textContent = kind === 'profile' ? '编辑显示名称' : '修改密码'
    if (kind === 'profile') (profileForm.elements.namedItem('displayName') as HTMLInputElement).value = session.user.displayName
    setStateMessage(editorStatus)
    requestAnimationFrame(() => (kind === 'profile' ? profileForm : passwordForm).querySelector<HTMLInputElement>('input')?.focus())
  }

  const showRecoveryCode = (code: string) => {
    closeEditor()
    auth.hidden = true
    dashboard.hidden = true
    result.hidden = false
    const target = result.querySelector<HTMLElement>('[data-recovery-code]')
    if (target) target.textContent = code
    resetAccountScroll()
  }

  const renderSession = async () => {
    const session = readSession()
    auth.hidden = Boolean(session)
    dashboard.hidden = !session
    result.hidden = true
    if (!session) return
    dashboard.querySelector<HTMLElement>('[data-account-display-name]')!.textContent = session.user.displayName
    dashboard.querySelector<HTMLElement>('[data-account-username]')!.textContent = `@${session.user.username}`
    dashboard.querySelector<HTMLElement>('[data-account-avatar]')!.textContent = session.user.displayName.slice(0, 1).toLocaleUpperCase()
    dashboard.querySelector<HTMLElement>('[data-account-profile-name]')!.textContent = session.user.displayName
    dashboard.querySelector<HTMLElement>('[data-account-profile-username]')!.textContent = `@${session.user.username}`
    const displayInput = profileForm.elements.namedItem('displayName') as HTMLInputElement
    displayInput.value = session.user.displayName
    await loadDevices()
  }

  const loadDevices = async () => {
    const list = dashboard.querySelector<HTMLElement>('[data-device-list]')
    if (!list || !readSession()) return
    list.replaceChildren()
    try {
      const { devices } = await cloudRequest<{ devices: CloudDevice[] }>('/v1/me/devices', {}, true)
      devices.forEach((device) => {
        const row = document.createElement('article')
        const copy = document.createElement('span')
        const name = document.createElement('strong')
        const meta = document.createElement('small')
        name.textContent = device.current ? `${device.name} · 当前设备` : device.name
        meta.textContent = `最近使用 ${new Date(device.lastSeenAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
        copy.append(name, meta)
        row.append(copy)
        if (!device.current) {
          const revoke = document.createElement('button')
          revoke.type = 'button'
          revoke.textContent = '退出'
          revoke.addEventListener('click', async () => {
            try { await cloudRequest(`/v1/me/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' }, true); await loadDevices() }
            catch (error) { setStateMessage(status, error instanceof Error ? error.message : '设备操作未完成', 'error') }
          })
          row.append(revoke)
        }
        list.append(row)
      })
    } catch (error) {
      setStateMessage(status, error instanceof Error ? error.message : '设备列表暂不可用', 'error')
      if (!readSession()) await renderSession()
    }
  }

  const selectMode = (nextMode: typeof mode) => {
    mode = nextMode
    const recoveryField = form.querySelector<HTMLElement>('[data-recovery-field]')
    const displayField = form.querySelector<HTMLElement>('[data-display-name-field]')
    const passwordLabel = form.querySelector<HTMLElement>('[data-password-label]')
    const title = auth.querySelector<HTMLElement>('[data-account-auth-title]')
    const copy = auth.querySelector<HTMLElement>('[data-account-auth-copy]')
    const submit = form.querySelector<HTMLButtonElement>('[data-account-submit]')
    if (recoveryField) recoveryField.hidden = mode !== 'recover'
    if (displayField) displayField.hidden = mode !== 'register'
    if (back) back.hidden = mode === 'login'
    if (authLinks) authLinks.hidden = mode !== 'login'
    if (passwordLabel) passwordLabel.textContent = mode === 'recover' ? '新密码' : '密码'
    if (title) title.textContent = mode === 'register' ? '创建账户' : mode === 'recover' ? '重设密码' : mode === 'restore' ? '恢复账户' : '登录 Echora'
    if (copy) {
      copy.hidden = mode === 'login'
      copy.textContent = mode === 'register' ? '创建后将生成账户恢复码。' : mode === 'recover' ? '输入恢复码和新密码。' : mode === 'restore' ? '此账户正在等待删除。' : ''
    }
    if (submit) submit.textContent = mode === 'register' ? '创建账户' : mode === 'recover' ? '重设密码' : mode === 'restore' ? '恢复账户' : '登录'
    const password = form.elements.namedItem('password') as HTMLInputElement
    password.autocomplete = mode === 'register' ? 'new-password' : mode === 'recover' ? 'new-password' : 'current-password'
    setStateMessage(status)
    resetAccountScroll()
  }

  document.querySelectorAll<HTMLButtonElement>('[data-account-mode]').forEach((button) => button.addEventListener('click', () => selectMode(button.dataset.accountMode as typeof mode)))
  back?.addEventListener('click', () => { form.reset(); selectMode('login') })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    const username = String(data.get('username') || '').trim()
    const password = String(data.get('password') || '')
    const recoveryCode = String(data.get('recoveryCode') || '').trim()
    const displayName = String(data.get('displayName') || '').trim()
    const submit = form.querySelector<HTMLButtonElement>('[data-account-submit]')!
    submit.disabled = true
        setStateMessage(status, '处理中')
    try {
      if (mode === 'register') {
        const response = await requestWithChallenge(
          (turnstileToken) => cloudRequest<{ token: string; user: CloudUser; recoveryCode: string }>('/v1/auth/register', { method: 'POST', body: JSON.stringify({ username, password, displayName, turnstileToken }) }),
          turnstileSlot,
        )
        writeSession({ token: response.token, user: response.user })
        setStateMessage(status)
        showRecoveryCode(response.recoveryCode)
      } else if (mode === 'recover') {
        const response = await requestWithChallenge(
          (turnstileToken) => cloudRequest<{ recoveryCode: string }>('/v1/auth/recover', { method: 'POST', body: JSON.stringify({ username, recoveryCode, newPassword: password, turnstileToken }) }),
          turnstileSlot,
        )
        setStateMessage(status)
        showRecoveryCode(response.recoveryCode)
      } else if (mode === 'restore') {
        await requestWithChallenge(
          (turnstileToken) => cloudRequest('/v1/auth/restore', { method: 'POST', body: JSON.stringify({ username, password, turnstileToken }) }),
          turnstileSlot,
        )
        selectMode('login')
        setStateMessage(status, '账户已恢复，请重新登录', 'success')
      } else {
        const response = await requestWithChallenge(
          (turnstileToken) => cloudRequest<{ token: string; user: CloudUser }>('/v1/auth/login', { method: 'POST', body: JSON.stringify({ username, password, turnstileToken }) }),
          turnstileSlot,
        )
        writeSession(response)
        await renderSession()
        resetAccountScroll()
        setStateMessage(status)
      }
      form.reset()
    } catch (error) {
      if (mode === 'login' && error instanceof WebsiteApiError && error.status === 423) {
        selectMode('restore')
        const usernameInput = form.elements.namedItem('username') as HTMLInputElement
        usernameInput.value = username
        setStateMessage(status, '确认密码即可撤销删除。')
      } else {
        setStateMessage(status, error instanceof Error ? error.message : '账户操作未完成', 'error')
      }
    } finally {
      submit.disabled = false
    }
  })
  profileForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const displayName = String(new FormData(profileForm).get('displayName') || '').trim()
    try {
      const { user } = await cloudRequest<{ user: CloudUser }>('/v1/me', { method: 'PUT', body: JSON.stringify({ displayName }) }, true)
      const session = readSession()
      if (session) writeSession({ ...session, user })
      closeEditor()
      setStateMessage(status, '显示名称已更新', 'success')
      await renderSession()
    } catch (error) { setStateMessage(editorStatus, error instanceof Error ? error.message : '资料更新未完成', 'error') }
  })
  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(passwordForm)
    const currentPassword = String(data.get('currentPassword') || '')
    const newPassword = String(data.get('newPassword') || '')
    const confirmPassword = String(data.get('confirmPassword') || '')
    if (newPassword !== confirmPassword) {
      setStateMessage(editorStatus, '两次输入的新密码不一致', 'error')
      return
    }
    const submit = passwordForm.querySelector<HTMLButtonElement>('button[type="submit"]')!
    submit.disabled = true
    try {
      const response = await cloudRequest<{ recoveryCode: string }>('/v1/me/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }, true)
      passwordForm.reset()
      setStateMessage(status)
      showRecoveryCode(response.recoveryCode)
    } catch (error) {
      setStateMessage(editorStatus, error instanceof Error ? error.message : '密码未更新', 'error')
    } finally {
      submit.disabled = false
    }
  })
  deleteForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const password = String(new FormData(deleteForm).get('password') || '')
    try {
      const deletion = await cloudRequest<{ deletionDueAt: number }>('/v1/me/deletion', { method: 'POST', body: JSON.stringify({ password }) }, true)
      writeSession(null)
      selectMode('login')
      await renderSession()
        setStateMessage(status, `已申请删除，可在 ${new Date(deletion.deletionDueAt).toLocaleDateString('zh-CN')} 前恢复`, 'success')
    } catch (error) { setStateMessage(status, error instanceof Error ? error.message : '删除申请未完成', 'error') }
  })
  dashboard.querySelector<HTMLButtonElement>('[data-account-logout]')?.addEventListener('click', async () => {
    try { await cloudRequest('/v1/auth/logout', { method: 'POST' }, true) } catch { /* Local logout remains available. */ }
    writeSession(null)
    setStateMessage(status)
    await renderSession()
  })
  dashboard.querySelectorAll<HTMLButtonElement>('[data-account-edit]').forEach((button) => button.addEventListener('click', () => openEditor(button.dataset.accountEdit as 'profile' | 'password')))
  editor.querySelectorAll<HTMLButtonElement>('[data-account-editor-close], [data-account-editor-cancel]').forEach((button) => button.addEventListener('click', closeEditor))
  editor.addEventListener('pointerdown', (event) => { if (event.target === editor) closeEditor() })
  addEventListener('keydown', (event) => { if (event.key === 'Escape' && !editor.hidden) closeEditor() })
  dashboard.querySelector<HTMLButtonElement>('[data-device-refresh]')?.addEventListener('click', () => void loadDevices())
  result.querySelector<HTMLButtonElement>('[data-recovery-done]')?.addEventListener('click', () => {
    setStateMessage(status)
    void renderSession()
    resetAccountScroll()
  })
  void renderSession()
}

type SystemConfig = {
  music: { enabledProviders: string[]; preferredSourceOrder: string[] }
  features: { registration: boolean; echoraAi: boolean; customAi: boolean; turnstile: boolean }
}

type CredentialSummary = {
  music: { configured: boolean }
  turnstile: { configured: boolean; siteKey: string }
  ai: { configured: boolean; provider: 'openai' | 'anthropic' | 'compatible'; baseUrl: string; model: string }
}

type AdminOverview = {
  admin: AdminIdentity
  users: { total: number; new7d: number; activeSessions: number; suspended: number; pendingDeletion: number }
  music: { enabledProviders: number; totalProviders: number; resolverConfigured: boolean; providers: Array<{ id: string; name: string; enabled: boolean; priority: number }> }
  ai: { echoraEnabled: boolean; echoraConfigured: boolean; customEnabled: boolean; customConfiguredUsers: number }
  recentActivity: Array<{ action: string; target: string; createdAt: number }>
}

type AdminMusicHealth = {
  days: 7 | 30
  providers: Array<{
    id: string
    name: string
    enabled: boolean
    priority: number
    state: 'healthy' | 'degraded' | 'unavailable' | 'unknown' | 'disabled'
    requestCount: number
    successRate: number | null
    averageLatencyMs: number | null
    delegatedCount: number
    downgradeCount: number
    lastError: { code: string; message: string; at: number } | null
    operations: Record<'search' | 'chart' | 'resolve' | 'playback', {
      requestCount: number
      successCount: number
      errorCount: number
      delegatedCount: number
      averageLatencyMs: number | null
      downgradeCount: number
    }>
  }>
}

type AdminVersionRelease = {
  id: string
  product: string
  channel: string
  version: string
  buildId: string | null
  status: 'draft' | 'pending' | 'published' | 'paused' | 'withdrawn'
  minimumVersion: string
  rolloutPercentage: number
  releaseNotes: string
  source: string
  sourceUrl: string | null
  publishedAt: number | null
  updatedAt: number
  artifactCount: number
}

type AdminVersions = {
  products: Array<{ key: string; name: string; type: 'web' | 'service' | 'desktop' | 'mobile'; active: boolean }>
  releases: AdminVersionRelease[]
  deployments: Array<{ id: string; product: string; environment: string; version: string; buildId: string; commit: string | null; url: string | null; status: string; deployedAt: number }>
  sync: Array<{ id: number; source: string; channel: string | null; status: string; detail: Record<string, unknown> | null; createdAt: number }>
}

type AdminUser = CloudUser & {
  deletionDueAt: number | null
  disabledAt: number | null
  deviceCount: number
  lastActiveAt: number | null
  contentCount: number
  customAiConfigured: boolean
}

type AdminAuditEvent = {
  id: number
  action: string
  target: string
  detail: Record<string, unknown> | null
  createdAt: number
  admin: { username: string; displayName: string }
}

const setupAdmin = () => {
  if (activeRoute !== 'admin') return
  document.querySelector<HTMLElement>('.site-header')?.setAttribute('hidden', '')
  document.querySelector<HTMLElement>('body > footer')?.setAttribute('hidden', '')
  const auth = document.querySelector<HTMLElement>('[data-admin-auth]')
  const workspace = document.querySelector<HTMLElement>('[data-admin-workspace]')
  const loginForm = document.querySelector<HTMLFormElement>('[data-admin-login]')
  const configForm = document.querySelector<HTMLFormElement>('[data-admin-config-form]')
  const passwordForm = document.querySelector<HTMLFormElement>('[data-admin-password-form]')
  const loginStatus = document.querySelector<HTMLElement>('[data-admin-status]')
  const configStatus = document.querySelector<HTMLElement>('[data-admin-config-status]')
  const securityStatus = document.querySelector<HTMLElement>('[data-admin-security-status]')
  const versionStatus = document.querySelector<HTMLElement>('[data-admin-version-status]')
  const logoutButton = document.querySelector<HTMLButtonElement>('[data-admin-logout]')
  const turnstileSlot = document.querySelector<HTMLElement>('[data-admin-turnstile]')
  if (!auth || !workspace || !loginForm || !configForm || !passwordForm || !logoutButton || !turnstileSlot) return
  const providerLabels: Record<string, string> = { tx: 'QQ 音乐', wy: '网易云音乐', kw: '酷我音乐', kg: '酷狗音乐', mg: '咪咕音乐' }
  const configurableFeatures = ['echoraAi', 'turnstile'] as const
  let providerOrder = Object.keys(providerLabels)
  let draggedProvider = ''
  let versionData: AdminVersions | null = null
  let musicHealthDays: 7 | 30 = 7
  const syncFeaturePanels = () => configurableFeatures.forEach((name) => {
    const toggle = configForm.elements.namedItem(name) as HTMLInputElement | null
    const panel = configForm.querySelector<HTMLElement>(`[data-feature-config="${name}"]`)
    if (panel) panel.hidden = !toggle?.checked
  })
  const rememberProviderSelection = () => {
    configForm.dataset.enabledProviders = providerOrder.filter((id) => (configForm.elements.namedItem(`provider:${id}`) as HTMLInputElement | null)?.checked).join(',')
  }

  const renderProviders = () => {
    const providers = configForm.querySelector<HTMLElement>('[data-admin-providers]')!
    providers.replaceChildren(...providerOrder.map((id, index) => {
      const row = document.createElement('article')
      row.draggable = true
      row.dataset.providerId = id
      const grip = document.createElement('span')
      grip.className = 'admin-provider-grip'
      grip.setAttribute('aria-hidden', 'true')
      grip.innerHTML = '<i data-lucide="grip-vertical"></i>'
      const priority = document.createElement('em')
      priority.textContent = String(index + 1).padStart(2, '0')
      const copy = document.createElement('span')
      const name = document.createElement('strong')
      const state = document.createElement('small')
      const toggle = document.createElement('label')
      const input = document.createElement('input')
      const rail = document.createElement('i')
      const actions = document.createElement('div')
      name.textContent = providerLabels[id]
      input.type = 'checkbox'
      input.name = `provider:${id}`
      input.checked = configForm.dataset.enabledProviders?.split(',').includes(id) ?? true
      state.textContent = input.checked ? '参与聚合' : '已停用'
      toggle.className = 'admin-switch'
      toggle.setAttribute('aria-label', `${providerLabels[id]}参与聚合`)
      toggle.append(input, rail)
      input.addEventListener('change', () => {
        const enabled = providerOrder.filter((provider) => (configForm.elements.namedItem(`provider:${provider}`) as HTMLInputElement | null)?.checked)
        if (!enabled.length) {
          input.checked = true
          setStateMessage(configStatus, '至少保留一个音乐平台', 'error')
        }
        state.textContent = input.checked ? '参与聚合' : '已停用'
        row.classList.toggle('is-disabled', !input.checked)
      })
      copy.append(name, state)
      ;[-1, 1].forEach((offset) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.innerHTML = `<i data-lucide="${offset < 0 ? 'arrow-up' : 'arrow-down'}"></i>`
        button.setAttribute('aria-label', offset < 0 ? '提高优先级' : '降低优先级')
        button.title = offset < 0 ? '提高优先级' : '降低优先级'
        button.disabled = index + offset < 0 || index + offset >= providerOrder.length
        button.addEventListener('click', () => {
          rememberProviderSelection()
          const next = [...providerOrder]
          ;[next[index], next[index + offset]] = [next[index + offset], next[index]]
          providerOrder = next
          renderProviders()
        })
        actions.append(button)
      })
      row.addEventListener('dragstart', () => { draggedProvider = id; row.classList.add('is-dragging') })
      row.addEventListener('dragend', () => { draggedProvider = ''; row.classList.remove('is-dragging') })
      row.addEventListener('dragover', (event) => {
        event.preventDefault()
        if (!draggedProvider || draggedProvider === id) return
        rememberProviderSelection()
        const next = providerOrder.filter((provider) => provider !== draggedProvider)
        next.splice(next.indexOf(id), 0, draggedProvider)
        providerOrder = next
        renderProviders()
      })
      row.classList.toggle('is-disabled', !input.checked)
      row.append(grip, priority, copy, toggle, actions)
      return row
    }))
    createIcons({ icons })
  }

  const fillConfig = (config: SystemConfig, credentials: CredentialSummary) => {
    providerOrder = [...config.music.preferredSourceOrder, ...Object.keys(providerLabels).filter((id) => !config.music.preferredSourceOrder.includes(id))]
    configForm.dataset.enabledProviders = config.music.enabledProviders.join(',')
    renderProviders()
    ;(['registration', 'echoraAi', 'customAi', 'turnstile'] as const).forEach((name) => { (configForm.elements.namedItem(name) as HTMLInputElement).checked = config.features[name] })
    ;(configForm.elements.namedItem('aiProvider') as HTMLSelectElement).value = credentials.ai.provider
    ;(configForm.elements.namedItem('aiBaseUrl') as HTMLInputElement).value = credentials.ai.baseUrl
    ;(configForm.elements.namedItem('aiModel') as HTMLInputElement).value = credentials.ai.model
    ;(configForm.elements.namedItem('turnstileSiteKey') as HTMLInputElement).value = credentials.turnstile.siteKey
    ;(configForm.elements.namedItem('musicResolverKey') as HTMLInputElement).value = ''
    ;(configForm.elements.namedItem('aiApiKey') as HTMLInputElement).value = ''
    ;(configForm.elements.namedItem('clearMusicResolver') as HTMLInputElement).checked = false
    ;(configForm.elements.namedItem('clearAiApiKey') as HTMLInputElement).checked = false
    ;(configForm.elements.namedItem('turnstileSecretKey') as HTMLInputElement).value = ''
    ;(configForm.elements.namedItem('clearTurnstileSecret') as HTMLInputElement).checked = false
    const musicState = configForm.querySelector<HTMLElement>('[data-music-secret-state]')
    const aiState = configForm.querySelector<HTMLElement>('[data-ai-secret-state]')
    const turnstileState = configForm.querySelector<HTMLElement>('[data-turnstile-secret-state]')
    if (musicState) musicState.textContent = credentials.music.configured ? '已配置 · 输入新值可替换' : '尚未配置'
    if (aiState) {
      aiState.dataset.ready = String(credentials.ai.configured)
      aiState.textContent = credentials.ai.configured ? '服务配置完整' : '还需要服务地址、模型与 API 密钥'
    }
    if (turnstileState) {
      turnstileState.dataset.ready = String(credentials.turnstile.configured)
      turnstileState.textContent = credentials.turnstile.configured ? 'Turnstile 配置完整' : '还需要站点密钥与服务密钥'
    }
    syncFeaturePanels()
  }

  const renderAdminIdentity = (admin: AdminIdentity) => {
    const name = document.querySelector<HTMLElement>('[data-admin-display-name]')
    const username = document.querySelector<HTMLElement>('[data-admin-username]')
    const avatar = document.querySelector<HTMLElement>('[data-admin-avatar]')
    if (name) name.textContent = admin.displayName
    if (username) username.textContent = `@${admin.username}`
    if (avatar) avatar.textContent = admin.displayName.slice(0, 1).toLocaleUpperCase()
  }

  const adminActionLabels: Record<string, string> = {
    'config.update': '更新服务配置',
    'user.disable': '停用用户',
    'user.enable': '恢复用户',
    'user.revoke_sessions': '退出用户设备',
    'user.cancel_deletion': '撤销账户删除',
    'admin.password.update': '修改管理员密码',
    'version.github_sync': '同步 GitHub 发布',
    'version.update': '更新发布策略',
    'version.publish': '发布版本',
    'version.pause': '暂停版本',
    'version.withdraw': '撤回版本',
    'version.pending': '提交版本审核',
  }

  const loadOverview = async () => {
    const [overview, musicHealth] = await Promise.all([
      adminRequest<AdminOverview>('/v1/admin/overview'),
      adminRequest<AdminMusicHealth>('/v1/admin/music/health?days=7').catch(() => null),
    ])
    renderAdminIdentity(overview.admin)
    const metrics = document.querySelector<HTMLElement>('[data-admin-metrics]')
    const metricItems = [
      ['用户', overview.users.total, `近 7 日新增 ${overview.users.new7d} · ${overview.users.activeSessions} 个有效会话`],
      ['音乐服务', `${overview.music.enabledProviders}/${overview.music.totalProviders}`, overview.music.resolverConfigured ? '解析服务已配置' : '解析服务待配置'],
      ['AI', overview.ai.echoraEnabled && overview.ai.echoraConfigured ? '可用' : '待配置', `自定义 AI ${overview.ai.customEnabled ? '已开放' : '未开放'} · ${overview.ai.customConfiguredUsers} 位用户已配置`],
    ] as const
    metrics?.replaceChildren(...metricItems.map(([label, value, description]) => {
      const item = document.createElement('article')
      const caption = document.createElement('span')
      const amount = document.createElement('strong')
      const detail = document.createElement('small')
      caption.textContent = label
      amount.textContent = String(value)
      detail.textContent = description
      item.append(caption, amount, detail)
      return item
    }))
    const musicState = document.querySelector<HTMLElement>('[data-admin-music-state]')
    if (musicState) musicState.textContent = `${overview.music.enabledProviders} 个平台参与聚合 · 近 7 日`
    const providerSummary = document.querySelector<HTMLElement>('[data-admin-provider-summary]')
    const healthByProvider = new Map(musicHealth?.providers.map((provider) => [provider.id, provider]) || [])
    const healthStateLabels = { healthy: '稳定', degraded: '波动', unavailable: '异常', unknown: '待观察', disabled: '已停用' } as const
    providerSummary?.replaceChildren(...overview.music.providers.map((provider) => {
      const health = healthByProvider.get(provider.id)
      const row = document.createElement('div')
      row.className = 'admin-provider-health'
      const copy = document.createElement('span')
      const name = document.createElement('strong')
      const state = document.createElement('small')
      const metrics = document.createElement('span')
      metrics.className = 'admin-provider-health-metrics'
      name.textContent = provider.name
      state.textContent = provider.enabled ? `优先级 ${provider.priority}` : '未参与聚合'
      row.classList.toggle('is-disabled', !provider.enabled)
      if (!provider.enabled) {
        metrics.textContent = '已停用'
        metrics.dataset.state = 'disabled'
      } else if (!health || health.requestCount === 0) {
        metrics.textContent = '尚无运行样本'
        metrics.dataset.state = 'unknown'
      } else {
        const success = document.createElement('b')
        const latency = document.createElement('b')
        const handoff = document.createElement('b')
        success.textContent = health.successRate == null ? '待观察' : `${healthStateLabels[health.state]} · ${Math.round(health.successRate * 100)}%`
        latency.textContent = health.averageLatencyMs == null ? '耗时待观察' : health.averageLatencyMs < 1_000 ? `${health.averageLatencyMs} ms` : `${(health.averageLatencyMs / 1_000).toFixed(1)} 秒`
        handoff.textContent = health.delegatedCount ? `终端接续 ${health.delegatedCount}` : `${health.requestCount} 次调用`
        metrics.dataset.state = health.state
        if (health.lastError) metrics.title = `最近异常：${health.lastError.message}`
        metrics.append(success, latency, handoff)
      }
      copy.append(name, state)
      row.append(copy, metrics)
      return row
    }))
    const aiState = document.querySelector<HTMLElement>('[data-admin-ai-state]')
    if (aiState) aiState.textContent = overview.ai.echoraEnabled && overview.ai.echoraConfigured ? '服务正常' : '待完成配置'
    const aiSummary = document.querySelector<HTMLElement>('[data-admin-ai-summary]')
    const aiRows = [
      ['EchoraAI', !overview.ai.echoraEnabled ? '未开放' : overview.ai.echoraConfigured ? '可用' : '待配置'],
      ['自定义 AI', overview.ai.customEnabled ? `${overview.ai.customConfiguredUsers} 位用户已配置` : '未开放'],
    ]
    aiSummary?.replaceChildren(...aiRows.map(([label, value]) => {
      const row = document.createElement('div')
      const name = document.createElement('strong')
      const state = document.createElement('span')
      name.textContent = label
      state.textContent = value
      row.append(name, state)
      return row
    }))
    const activity = document.querySelector<HTMLElement>('[data-admin-recent-activity]')
    activity?.replaceChildren(...(overview.recentActivity.length ? overview.recentActivity.map((event) => {
      const row = document.createElement('div')
      const copy = document.createElement('span')
      const title = document.createElement('strong')
      const target = document.createElement('small')
      const time = document.createElement('time')
      title.textContent = adminActionLabels[event.action] || event.action
      target.textContent = event.target
      time.textContent = new Date(event.createdAt).toLocaleString('zh-CN')
      copy.append(title, target)
      row.append(copy, time)
      return row
    }) : [Object.assign(document.createElement('div'), { className: 'admin-empty-state', textContent: '暂无管理操作' })]))
  }

  const formatHealthLatency = (value: number | null) => value == null
    ? '—'
    : value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(1)} 秒`

  const loadMusicHealth = async (days: 7 | 30 = musicHealthDays) => {
    const status = document.querySelector<HTMLElement>('[data-admin-health-status]')
    const metrics = document.querySelector<HTMLElement>('[data-admin-health-metrics]')
    const list = document.querySelector<HTMLElement>('[data-admin-health-list]')
    if (!metrics || !list) return
    musicHealthDays = days
    document.querySelectorAll<HTMLButtonElement>('[data-admin-health-days]').forEach((button) => {
      button.classList.toggle('is-active', Number(button.dataset.adminHealthDays) === days)
    })
    setStateMessage(status)
    try {
      const health = await adminRequest<AdminMusicHealth>(`/v1/admin/music/health?days=${days}`)
      const activeProviders = health.providers.filter((provider) => provider.enabled)
      const totals = activeProviders.reduce((value, provider) => ({
        requests: value.requests + provider.requestCount,
        success: value.success + Object.values(provider.operations).reduce((sum, operation) => sum + operation.successCount, 0),
        errors: value.errors + Object.values(provider.operations).reduce((sum, operation) => sum + operation.errorCount, 0),
        playback: value.playback + provider.operations.playback.successCount,
      }), { requests: 0, success: 0, errors: 0, playback: 0 })
      const successRate = totals.success + totals.errors ? Math.round(totals.success / (totals.success + totals.errors) * 100) : null
      const summary = [
        ['运行样本', totals.requests.toLocaleString('zh-CN'), `${activeProviders.length} 个平台`],
        ['完成率', successRate == null ? '—' : `${successRate}%`, `近 ${days} 天`],
        ['实际播放', totals.playback.toLocaleString('zh-CN'), '已确认开始'],
      ]
      metrics.replaceChildren(...summary.map(([label, value, detail]) => {
        const item = document.createElement('article')
        const caption = document.createElement('span')
        const amount = document.createElement('strong')
        const note = document.createElement('small')
        caption.textContent = label
        amount.textContent = value
        note.textContent = detail
        item.append(caption, amount, note)
        return item
      }))

      const operationLabels = { search: '搜索', chart: '榜单', resolve: '解析', playback: '实际播放' } as const
      const stateLabels = { healthy: '稳定', degraded: '波动', unavailable: '异常', unknown: '待观察', disabled: '已停用' } as const
      list.replaceChildren(...health.providers.map((provider) => {
        const card = document.createElement('article')
        card.className = 'admin-health-provider'
        card.dataset.state = provider.state
        const header = document.createElement('header')
        const identity = document.createElement('div')
        const name = document.createElement('h2')
        const meta = document.createElement('span')
        const state = document.createElement('em')
        name.textContent = provider.name
        meta.textContent = provider.enabled ? `优先级 ${provider.priority}` : '未参与聚合'
        state.textContent = provider.requestCount ? `${stateLabels[provider.state]} · ${provider.successRate == null ? '—' : `${Math.round(provider.successRate * 100)}%`}` : stateLabels[provider.state]
        identity.append(name, meta)
        header.append(identity, state)

        const operations = document.createElement('div')
        operations.className = 'admin-health-operations'
        operations.replaceChildren(...Object.entries(operationLabels).map(([operationId, operationLabel]) => {
          const operation = provider.operations[operationId as keyof typeof provider.operations]
          const item = document.createElement('section')
          const label = document.createElement('span')
          const value = document.createElement('strong')
          const detail = document.createElement('small')
          const samples = operation.successCount + operation.errorCount
          label.textContent = operationLabel
          value.textContent = samples ? `${Math.round(operation.successCount / samples * 100)}%` : '—'
          detail.textContent = operation.requestCount ? `${operation.requestCount} 次 · ${formatHealthLatency(operation.averageLatencyMs)}` : '尚无运行样本'
          item.append(label, value, detail)
          return item
        }))

        const footer = document.createElement('footer')
        const handoff = document.createElement('span')
        const downgrade = document.createElement('span')
        const latest = document.createElement('span')
        handoff.textContent = `终端接续 ${provider.delegatedCount}`
        downgrade.textContent = `音质降级 ${provider.downgradeCount}`
        latest.textContent = provider.lastError
          ? `最近异常：${provider.lastError.message} · ${new Date(provider.lastError.at).toLocaleString('zh-CN')}`
          : '暂无异常记录'
        footer.append(handoff, downgrade, latest)
        card.append(header, operations, footer)
        return card
      }))
    } catch (error) {
      metrics.replaceChildren()
      list.replaceChildren(Object.assign(document.createElement('div'), { className: 'admin-empty-state', textContent: '运行数据暂时不可用' }))
      setStateMessage(status, error instanceof Error ? error.message : '运行数据暂时不可用', 'error')
    }
  }

  const versionStatusLabels: Record<AdminVersionRelease['status'], string> = {
    draft: '草稿', pending: '待发布', published: '已发布', paused: '已暂停', withdrawn: '已撤回',
  }
  const productIcon = (type: AdminVersions['products'][number]['type']) => type === 'mobile' ? 'smartphone' : type === 'web' ? 'globe-2' : type === 'service' ? 'sparkles' : 'monitor'
  const formatAdminTime = (value: number | null | undefined) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

  const renderVersions = (data: AdminVersions) => {
    versionData = data
    const products = document.querySelector<HTMLElement>('[data-admin-version-products]')
    products?.replaceChildren(...data.products.map((product) => {
      const release = data.releases.find((item) => item.product === product.key && item.status === 'published')
      const deployment = data.deployments.find((item) => item.product === product.key && item.environment === 'production')
      const row = document.createElement('article')
      const identity = document.createElement('span')
      identity.className = 'admin-version-product'
      identity.innerHTML = `<i data-lucide="${productIcon(product.type)}"></i><span><strong>${product.name}</strong><small>${product.key}</small></span>`
      const releaseCell = document.createElement('span')
      releaseCell.innerHTML = release ? `<strong>v${release.version}</strong><small>${release.channel}</small>` : '<strong>—</strong><small>尚未发布</small>'
      const deploymentCell = document.createElement('span')
      deploymentCell.innerHTML = deployment ? `<strong>v${deployment.version}</strong><small>${deployment.buildId}</small>` : '<strong>—</strong><small>暂无记录</small>'
      const state = document.createElement('em')
      const stateValue = deployment?.status || (release ? 'published' : 'unconfigured')
      state.dataset.state = stateValue
      state.textContent = deployment ? ({ healthy: '正常', degraded: '降级', failed: '异常', unknown: '未知' }[deployment.status] || deployment.status) : release ? '已发布' : '待配置'
      const updated = document.createElement('time')
      updated.textContent = formatAdminTime(deployment?.deployedAt || release?.publishedAt)
      row.append(identity, releaseCell, deploymentCell, state, updated)
      return row
    }))
    const channel = document.querySelector<HTMLSelectElement>('[data-admin-version-channel]')?.value || 'stable'
    const releases = data.releases.filter((release) => release.channel === channel)
    const list = document.querySelector<HTMLElement>('[data-admin-release-list]')
    list?.replaceChildren(...(releases.length ? releases.map((release) => {
      const product = data.products.find((item) => item.key === release.product)
      const row = document.createElement('article')
      const version = document.createElement('span')
      version.innerHTML = `<strong>v${release.version}</strong><small>${release.buildId || release.source}</small>`
      const productCell = document.createElement('span')
      productCell.textContent = product?.name || release.product
      const policy = document.createElement('span')
      policy.innerHTML = `<strong>${release.rolloutPercentage}%</strong><small>最低 v${release.minimumVersion}</small>`
      const state = document.createElement('em')
      state.dataset.state = release.status
      state.textContent = versionStatusLabels[release.status]
      const updated = document.createElement('time')
      updated.textContent = formatAdminTime(release.updatedAt)
      const manage = document.createElement('button')
      manage.type = 'button'
      manage.textContent = '管理'
      manage.addEventListener('click', () => openReleaseDialog(release.id))
      row.append(version, productCell, policy, state, updated, manage)
      return row
    }) : [Object.assign(document.createElement('div'), { className: 'admin-empty-state', textContent: '该通道暂无发布记录' })]))
    createIcons({ icons })
  }

  const loadVersions = async () => {
    setStateMessage(versionStatus)
    try { renderVersions(await adminRequest<AdminVersions>('/v1/admin/versions')) }
    catch (error) { setStateMessage(versionStatus, error instanceof Error ? error.message : '版本信息读取失败', 'error') }
  }

  const releaseDialog = document.querySelector<HTMLDialogElement>('[data-admin-release-dialog]')
  const releaseForm = document.querySelector<HTMLFormElement>('[data-admin-release-form]')
  const openReleaseDialog = (releaseId: string) => {
    const release = versionData?.releases.find((item) => item.id === releaseId)
    if (!release || !releaseDialog || !releaseForm) return
    releaseForm.dataset.releaseId = release.id
    const title = releaseForm.querySelector<HTMLElement>('[data-admin-release-title]')
    const meta = releaseForm.querySelector<HTMLElement>('[data-admin-release-meta]')
    const primary = releaseForm.querySelector<HTMLButtonElement>('[data-admin-release-primary]')
    if (title) title.textContent = `${versionData?.products.find((item) => item.key === release.product)?.name || release.product} v${release.version}`
    if (meta) meta.textContent = `${versionStatusLabels[release.status]} · ${release.artifactCount} 个交付文件`
    ;(releaseForm.elements.namedItem('minimumVersion') as HTMLInputElement).value = release.minimumVersion
    ;(releaseForm.elements.namedItem('rolloutPercentage') as HTMLSelectElement).value = String(release.rolloutPercentage)
    ;(releaseForm.elements.namedItem('releaseNotes') as HTMLTextAreaElement).value = release.releaseNotes
    if (primary) {
      primary.dataset.action = release.status === 'published' ? 'pause' : 'publish'
      primary.textContent = release.status === 'published' ? '暂停分发' : '发布版本'
      primary.classList.toggle('is-danger', release.status === 'published')
    }
    releaseDialog.showModal()
  }

  const runReleaseAction = async (action: string) => {
    const releaseId = releaseForm?.dataset.releaseId
    if (!releaseId || !releaseForm) return
    const button = releaseForm.querySelector<HTMLButtonElement>(action === 'update' ? '[data-admin-release-save]' : '[data-admin-release-primary]')
    if (button) button.disabled = true
    const data = new FormData(releaseForm)
    try {
      await adminRequest(`/v1/admin/versions/releases/${encodeURIComponent(releaseId)}`, {
        method: 'POST',
        body: JSON.stringify({ action, minimumVersion: data.get('minimumVersion'), rolloutPercentage: Number(data.get('rolloutPercentage')), releaseNotes: data.get('releaseNotes') }),
      })
      releaseDialog?.close()
      await Promise.all([loadVersions(), loadAudit()])
      setStateMessage(versionStatus, action === 'update' ? '发布策略已保存' : action === 'pause' ? '版本已暂停' : '版本已发布', 'success')
    } catch (error) { setStateMessage(versionStatus, error instanceof Error ? error.message : '版本操作未完成', 'error') }
    finally { if (button) button.disabled = false }
  }

  let userPage = 1
  const loadUsers = async () => {
    const list = document.querySelector<HTMLElement>('[data-admin-user-list]')!
    const count = document.querySelector<HTMLElement>('[data-admin-user-count]')
    const statusMessage = document.querySelector<HTMLElement>('[data-admin-user-status-message]')
    const pagination = document.querySelector<HTMLElement>('[data-admin-user-pagination]')
    const query = document.querySelector<HTMLInputElement>('[data-admin-user-query]')?.value.trim() || ''
    const status = document.querySelector<HTMLSelectElement>('[data-admin-user-status]')?.value || 'all'
    const sort = document.querySelector<HTMLSelectElement>('[data-admin-user-sort]')?.value || 'created_desc'
    list.textContent = '正在读取用户'
    setStateMessage(statusMessage)
    try {
      const parameters = new URLSearchParams({ query, status, sort, page: String(userPage), pageSize: '25' })
      const { users, pagination: pageInfo } = await adminRequest<{ users: AdminUser[]; pagination: { page: number; pageSize: number; total: number; pages: number } }>(`/v1/admin/users?${parameters}`)
      if (count) count.textContent = String(pageInfo.total)
      if (!users.length) {
        list.innerHTML = '<div class="admin-empty-state">没有符合条件的用户</div>'
        if (pagination) pagination.hidden = true
        return
      }
      list.replaceChildren(...users.map((user) => {
        const row = document.createElement('article')
        row.classList.toggle('is-disabled', Boolean(user.disabledAt))
        const identity = document.createElement('span')
        const name = document.createElement('strong')
        const meta = document.createElement('small')
        const active = document.createElement('span')
        const activeTime = document.createElement('strong')
        const activeMeta = document.createElement('small')
        const content = document.createElement('span')
        const contentCount = document.createElement('strong')
        const contentMeta = document.createElement('small')
        const state = document.createElement('em')
        const controls = document.createElement('details')
        const controlsLabel = document.createElement('summary')
        const controlMenu = document.createElement('div')
        name.textContent = user.displayName
        meta.textContent = `@${user.username} · ${new Date(user.createdAt).toLocaleDateString('zh-CN')} 注册`
        activeTime.textContent = user.lastActiveAt ? new Date(user.lastActiveAt).toLocaleDateString('zh-CN') : '尚未登录'
        activeMeta.textContent = `${user.deviceCount} 个有效会话`
        contentCount.textContent = String(user.contentCount)
        contentMeta.textContent = user.customAiConfigured ? '已配置自定义 AI' : '账户内容'
        state.textContent = user.deletionDueAt ? '等待删除' : user.disabledAt ? '已停用' : '正常'
        state.dataset.state = user.deletionDueAt ? 'deletion' : user.disabledAt ? 'disabled' : 'active'
        identity.append(name, meta)
        active.append(activeTime, activeMeta)
        content.append(contentCount, contentMeta)
        controlsLabel.textContent = '管理'
        controls.append(controlsLabel, controlMenu)
        const runAction = async (action: 'disable' | 'enable' | 'revoke_sessions' | 'cancel_deletion') => {
          if (action === 'disable' && !confirm(`停用 @${user.username}？该用户将退出所有设备。`)) return
          try {
            await adminRequest(`/v1/admin/users/${encodeURIComponent(user.id)}`, { method: 'POST', body: JSON.stringify({ action }) })
            setStateMessage(statusMessage, action === 'cancel_deletion' ? '已撤销账户删除' : '用户状态已更新', 'success')
            await Promise.all([loadUsers(), loadOverview()])
          } catch (error) { setStateMessage(statusMessage, error instanceof Error ? error.message : '用户操作未完成', 'error') }
        }
        const revoke = document.createElement('button')
        revoke.type = 'button'
        revoke.textContent = '退出全部设备'
        revoke.disabled = user.deviceCount === 0
        revoke.addEventListener('click', () => void runAction('revoke_sessions'))
        const availability = document.createElement('button')
        availability.type = 'button'
        availability.className = user.disabledAt ? '' : 'is-danger'
        availability.textContent = user.disabledAt ? '恢复' : '停用'
        availability.addEventListener('click', () => void runAction(user.disabledAt ? 'enable' : 'disable'))
        controlMenu.append(revoke)
        if (user.deletionDueAt) {
          const cancelDeletion = document.createElement('button')
          cancelDeletion.type = 'button'
          cancelDeletion.textContent = '撤销删除'
          cancelDeletion.addEventListener('click', () => void runAction('cancel_deletion'))
          controlMenu.append(cancelDeletion)
        }
        controlMenu.append(availability)
        row.append(identity, active, content, state, controls)
        return row
      }))
      if (pagination) {
        pagination.hidden = pageInfo.pages <= 1
        const label = pagination.querySelector<HTMLElement>('[data-admin-user-page]')
        const previous = pagination.querySelector<HTMLButtonElement>('[data-admin-user-prev]')
        const next = pagination.querySelector<HTMLButtonElement>('[data-admin-user-next]')
        if (label) label.textContent = `${pageInfo.page} / ${pageInfo.pages}`
        if (previous) previous.disabled = pageInfo.page <= 1
        if (next) next.disabled = pageInfo.page >= pageInfo.pages
      }
    } catch (error) {
      list.textContent = ''
      setStateMessage(statusMessage, error instanceof Error ? error.message : '用户列表暂不可用', 'error')
    }
  }

  const loadAudit = async () => {
    const list = document.querySelector<HTMLElement>('[data-admin-audit-list]')
    if (!list) return
    list.textContent = '正在读取操作记录'
    try {
      const { events } = await adminRequest<{ events: AdminAuditEvent[] }>('/v1/admin/audit')
      if (!events.length) {
        list.innerHTML = '<div class="admin-empty-state">暂无操作记录</div>'
        return
      }
      list.replaceChildren(...events.map((event) => {
        const row = document.createElement('article')
        const copy = document.createElement('span')
        const title = document.createElement('strong')
        const meta = document.createElement('small')
        const target = document.createElement('code')
        title.textContent = adminActionLabels[event.action] || event.action
        meta.textContent = `${event.admin.displayName} · ${new Date(event.createdAt).toLocaleString('zh-CN')}`
        target.textContent = event.target
        copy.append(title, meta)
        row.append(copy, target)
        return row
      }))
    } catch (error) { list.textContent = error instanceof Error ? error.message : '操作记录暂不可用' }
  }

  const enter = async () => {
    try {
      const [{ admin }, response] = await Promise.all([
        adminRequest<{ admin: AdminIdentity }>('/v1/admin/me'),
        adminRequest<{ config: SystemConfig; credentials: CredentialSummary }>('/v1/admin/config'),
      ])
      auth.hidden = true
      workspace.hidden = false
      logoutButton.hidden = false
      renderAdminIdentity(admin)
      fillConfig(response.config, response.credentials)
      await loadOverview()
    } catch (error) {
      auth.hidden = false
      workspace.hidden = true
      logoutButton.hidden = true
      if (!(error instanceof WebsiteApiError && error.status === 401)) setStateMessage(loginStatus, error instanceof Error ? error.message : '无权访问系统管理', 'error')
    }
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(loginForm)
    const submit = loginForm.querySelector<HTMLButtonElement>('button[type="submit"]')!
    submit.disabled = true
    setStateMessage(loginStatus, '正在验证')
    try {
      await requestWithChallenge(
        (turnstileToken) => adminRequest<{ admin: AdminIdentity }>('/v1/admin/auth/login', { method: 'POST', body: JSON.stringify({ username: data.get('username'), password: data.get('password'), turnstileToken }) }),
        turnstileSlot,
      )
      loginForm.reset()
      setStateMessage(loginStatus)
      await enter()
    } catch (error) { setStateMessage(loginStatus, error instanceof Error ? error.message : '登录未完成', 'error') }
    finally { submit.disabled = false }
  })
  configForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    setStateMessage(configStatus)
    const enabledProviders = providerOrder.filter((id) => (configForm.elements.namedItem(`provider:${id}`) as HTMLInputElement)?.checked)
    if (!enabledProviders.length) return setStateMessage(configStatus, '至少保留一个音乐平台', 'error')
    const config: SystemConfig = {
      music: { enabledProviders, preferredSourceOrder: [...providerOrder] },
      features: {
        registration: (configForm.elements.namedItem('registration') as HTMLInputElement).checked,
        echoraAi: (configForm.elements.namedItem('echoraAi') as HTMLInputElement).checked,
        customAi: (configForm.elements.namedItem('customAi') as HTMLInputElement).checked,
        turnstile: (configForm.elements.namedItem('turnstile') as HTMLInputElement).checked,
      },
    }
    const musicResolverKey = (configForm.elements.namedItem('musicResolverKey') as HTMLInputElement).value.trim()
    const aiApiKey = (configForm.elements.namedItem('aiApiKey') as HTMLInputElement).value.trim()
    const turnstileSecretKey = (configForm.elements.namedItem('turnstileSecretKey') as HTMLInputElement).value.trim()
    const credentials = {
      musicResolverKey: (configForm.elements.namedItem('clearMusicResolver') as HTMLInputElement).checked ? null : musicResolverKey || undefined,
      aiProvider: (configForm.elements.namedItem('aiProvider') as HTMLSelectElement).value,
      aiBaseUrl: (configForm.elements.namedItem('aiBaseUrl') as HTMLInputElement).value.trim(),
      aiModel: (configForm.elements.namedItem('aiModel') as HTMLInputElement).value.trim(),
      aiApiKey: (configForm.elements.namedItem('clearAiApiKey') as HTMLInputElement).checked ? null : aiApiKey || undefined,
      turnstileSiteKey: (configForm.elements.namedItem('turnstileSiteKey') as HTMLInputElement).value.trim(),
      turnstileSecretKey: (configForm.elements.namedItem('clearTurnstileSecret') as HTMLInputElement).checked ? null : turnstileSecretKey || undefined,
    }
    try {
      const response = await adminRequest<{ config: SystemConfig; credentials: CredentialSummary }>('/v1/admin/config', { method: 'PUT', body: JSON.stringify({ config, credentials }) })
      setStateMessage(configStatus, '系统配置已更新', 'success')
      fillConfig(response.config, response.credentials)
      await Promise.all([loadOverview(), loadAudit()])
    } catch (error) { setStateMessage(configStatus, error instanceof Error ? error.message : '配置保存未完成', 'error') }
  })
  configurableFeatures.forEach((name) => (configForm.elements.namedItem(name) as HTMLInputElement | null)?.addEventListener('change', syncFeaturePanels))
  document.querySelectorAll<HTMLButtonElement>('[data-admin-section]').forEach((button) => button.addEventListener('click', () => {
    const section = button.dataset.adminSection
    setStateMessage(configStatus)
    setStateMessage(securityStatus)
    setStateMessage(versionStatus)
    document.querySelectorAll<HTMLButtonElement>('[data-admin-section]').forEach((item) => item.classList.toggle('is-active', item === button))
    document.querySelectorAll<HTMLElement>('[data-admin-panel]').forEach((panel) => { panel.hidden = panel.dataset.adminPanel !== section })
    if (section === 'overview') void loadOverview()
    if (section === 'music-health') void loadMusicHealth()
    if (section === 'versions') void loadVersions()
    if (section === 'users') void loadUsers()
    if (section === 'audit') void loadAudit()
  }))
  let userSearchTimer = 0
  document.querySelector<HTMLInputElement>('[data-admin-user-query]')?.addEventListener('input', () => {
    clearTimeout(userSearchTimer)
    userSearchTimer = window.setTimeout(() => { userPage = 1; void loadUsers() }, 250)
  })
  document.querySelector<HTMLSelectElement>('[data-admin-user-status]')?.addEventListener('change', () => { userPage = 1; void loadUsers() })
  document.querySelector<HTMLSelectElement>('[data-admin-user-sort]')?.addEventListener('change', () => { userPage = 1; void loadUsers() })
  document.querySelector<HTMLButtonElement>('[data-admin-users-refresh]')?.addEventListener('click', () => void loadUsers())
  document.querySelectorAll<HTMLButtonElement>('[data-admin-health-days]').forEach((button) => button.addEventListener('click', () => {
    void loadMusicHealth(Number(button.dataset.adminHealthDays) === 30 ? 30 : 7)
  }))
  document.querySelector<HTMLButtonElement>('[data-admin-user-prev]')?.addEventListener('click', () => { userPage = Math.max(1, userPage - 1); void loadUsers() })
  document.querySelector<HTMLButtonElement>('[data-admin-user-next]')?.addEventListener('click', () => { userPage += 1; void loadUsers() })
  document.querySelector<HTMLButtonElement>('[data-admin-audit-refresh]')?.addEventListener('click', () => void loadAudit())
  document.querySelector<HTMLSelectElement>('[data-admin-version-channel]')?.addEventListener('change', () => { if (versionData) renderVersions(versionData) })
  document.querySelector<HTMLButtonElement>('[data-admin-version-sync]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    setStateMessage(versionStatus)
    try {
      const channel = document.querySelector<HTMLSelectElement>('[data-admin-version-channel]')?.value || 'stable'
      const result = await adminRequest<{ releases: number; version?: string }>('/v1/admin/versions/github-sync', { method: 'POST', body: JSON.stringify({ channel }) })
      await Promise.all([loadVersions(), loadAudit()])
      setStateMessage(versionStatus, result.version
        ? `已导入 v${result.version}，生成 ${result.releases} 条待发布记录`
        : `已生成 ${result.releases} 条待发布记录`, 'success')
    } catch (error) { setStateMessage(versionStatus, error instanceof Error ? error.message : 'GitHub 同步失败', 'error') }
    finally { button.disabled = false }
  })
  document.querySelector<HTMLButtonElement>('[data-admin-release-close]')?.addEventListener('click', () => releaseDialog?.close())
  document.querySelector<HTMLButtonElement>('[data-admin-release-save]')?.addEventListener('click', () => void runReleaseAction('update'))
  document.querySelector<HTMLButtonElement>('[data-admin-release-primary]')?.addEventListener('click', (event) => void runReleaseAction((event.currentTarget as HTMLButtonElement).dataset.action || 'publish'))
  releaseDialog?.addEventListener('click', (event) => { if (event.target === releaseDialog) releaseDialog.close() })
  document.querySelector<HTMLButtonElement>('[data-admin-overview-audit]')?.addEventListener('click', () => {
    document.querySelector<HTMLButtonElement>('[data-admin-section="audit"]')?.click()
  })
  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    setStateMessage(securityStatus)
    const data = new FormData(passwordForm)
    const currentPassword = String(data.get('currentPassword') || '')
    const newPassword = String(data.get('newPassword') || '')
    const confirmPassword = String(data.get('confirmPassword') || '')
    if (newPassword !== confirmPassword) return setStateMessage(securityStatus, '两次输入的新密码不一致', 'error')
    const submit = passwordForm.querySelector<HTMLButtonElement>('button[type="submit"]')!
    submit.disabled = true
    try {
      await adminRequest('/v1/admin/me/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) })
      passwordForm.reset()
      setStateMessage(securityStatus, '密码已更新，其他管理会话已退出', 'success')
      await loadAudit()
    } catch (error) { setStateMessage(securityStatus, error instanceof Error ? error.message : '密码未更新', 'error') }
    finally { submit.disabled = false }
  })
  logoutButton.addEventListener('click', async () => {
    try { await adminRequest('/v1/admin/auth/logout', { method: 'POST' }) } catch { /* The page can still return to login. */ }
    await enter()
  })
  void enter()
}

const targetParts = (target: string) => target.split(':')
const platformFor = (action: DownloadAction): PlatformKey => {
  if (action.target === 'web') return 'web'
  const parts = targetParts(action.target)
  return (parts[1] in platformDefinitions ? parts[1] : 'web') as PlatformKey
}

const detectedPlatform = (): PlatformKey => {
  const value = navigator.userAgent.toLocaleLowerCase()
  if (/iphone|ipad|ipod/.test(value)) return 'ios'
  if (value.includes('android')) return 'android'
  if (value.includes('windows')) return 'windows'
  if (value.includes('linux')) return 'linux'
  if (value.includes('mac')) return 'darwin'
  return 'web'
}

type ArchitectureKey = 'aarch64' | 'x86_64' | 'universal' | string

const architectureFor = (action: DownloadAction): ArchitectureKey => targetParts(action.target)[2] || 'universal'

const detectedArchitecture = async (): Promise<ArchitectureKey | undefined> => {
  const userAgentData = (navigator as Navigator & {
    userAgentData?: { getHighEntropyValues: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }> }
  }).userAgentData
  if (!userAgentData?.getHighEntropyValues) return undefined
  try {
    const values = await userAgentData.getHighEntropyValues(['architecture', 'bitness'])
    if (values.architecture === 'arm' && values.bitness === '64') return 'aarch64'
    if (values.architecture === 'x86' && values.bitness === '64') return 'x86_64'
  } catch { /* Browsers may withhold high-entropy architecture hints. */ }
  return undefined
}

const downloadPresentation = (action: DownloadAction) => {
  const platform = platformFor(action)
  const architecture = architectureFor(action)
  if (platform === 'darwin' && architecture === 'aarch64') {
    return { eyebrow: 'macOS · Apple 芯片', title: 'Apple 芯片 Mac', detail: 'M1 及更新机型', button: '下载 Apple 芯片版', shortButton: 'Apple 芯片' }
  }
  if (platform === 'darwin' && architecture === 'x86_64') {
    return { eyebrow: 'macOS · Intel', title: 'Intel Mac', detail: 'Intel 处理器机型', button: '下载 Intel 版', shortButton: 'Intel' }
  }
  if (platform === 'windows' && architecture === 'x86_64') {
    return { eyebrow: 'Windows · x64', title: '64 位 Windows', detail: '适用于 x64 电脑', button: '下载 Windows x64', shortButton: 'Windows x64' }
  }
  if (platform === 'android' && architecture === 'universal') {
    return { eyebrow: 'Android · 通用', title: 'Android 通用版', detail: '适用于主流 Android 设备', button: '下载 Android APK', shortButton: 'Android' }
  }
  if (platform === 'ios') {
    return { eyebrow: 'iOS · 开发构建', title: 'iOS 未签名版', detail: '需要个人签名后安装', button: '下载 iOS 构建', shortButton: 'iOS' }
  }
  const definition = platformDefinitions[platform]
  return { eyebrow: definition.label, title: definition.detail, detail: definition.detail, button: action.type === 'web-refresh' ? '打开 Web 版' : `下载 ${definition.label}`, shortButton: definition.label }
}

const formatSize = (bytes?: number) => {
  if (!bytes || bytes < 1) return ''
  const megabytes = bytes / 1024 / 1024
  return `${megabytes >= 100 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`
}

const formatDate = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

const plainReleaseText = (value: string) => value
  .replace(/<[^>]*>/g, '')
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/[`*_~]/g, '')
  .trim()

const parsedReleaseNotes = (value: string) => {
  const lines = value.replace(/\r/g, '').split('\n')
  const sections: Array<{ title: string; items: string[] }> = []
  let summary = ''
  let current: { title: string; items: string[] } | undefined
  let beforeFirstHeading = true

  for (const rawLine of lines) {
    const line = rawLine.trim()
    const heading = line.match(/^#{1,6}\s+(.+)$/)
    if (heading) {
      beforeFirstHeading = false
      const title = plainReleaseText(heading[1])
      current = /^(本次更新|更新内容|主要更新|已知限制)$/.test(title) ? { title, items: [] } : undefined
      if (current) sections.push(current)
      continue
    }
    if (!line || /^<\/?(?:p|img)\b/i.test(line) || /^\|/.test(line)) continue
    if (beforeFirstHeading && !summary) {
      summary = plainReleaseText(line)
      continue
    }
    const item = line.match(/^[-*+]\s+(.+)$/)
    if (current && item) {
      const text = plainReleaseText(item[1])
      if (text) current.items.push(text)
    }
  }

  return {
    summary: summary || '包含稳定性与体验改进。',
    sections: sections.filter((section) => section.items.length),
  }
}

const renderReleaseNotes = (container: HTMLElement, value: string) => {
  const notes = parsedReleaseNotes(value)
  const lead = document.createElement('p')
  lead.className = 'release-notes-lead'
  lead.textContent = notes.summary
  container.replaceChildren(lead)
  if (!notes.sections.length) return

  const sectionList = document.createElement('div')
  sectionList.className = 'release-note-sections'
  notes.sections.forEach((section) => {
    const block = document.createElement('section')
    const heading = document.createElement('h3')
    heading.textContent = section.title
    const list = document.createElement('ul')
    section.items.forEach((item) => {
      const entry = document.createElement('li')
      entry.textContent = item
      list.append(entry)
    })
    block.append(heading, list)
    sectionList.append(block)
  })
  container.append(sectionList)
}

const downloadLabel = (action: DownloadAction) => downloadPresentation(action).button

const downloadTrustLabel = (action: DownloadAction) => {
  const platform = platformFor(action)
  if (platform === 'darwin' || platform === 'windows') return '未签名测试构建'
  if (platform === 'ios') return '开发构建'
  return action.sha256 ? '已提供校验' : '正式发布'
}

const downloadCard = (action: DownloadAction, recommended = false) => {
  const platform = platformFor(action)
  const definition = platformDefinitions[platform]
  const presentation = downloadPresentation(action)
  const article = document.createElement('article')
  article.className = `download-card${recommended ? ' is-recommended' : ''}`
  const copy = document.createElement('div')
  const label = document.createElement('span')
  label.className = 'download-card-platform'
  label.textContent = presentation.eyebrow
  const title = document.createElement('strong')
  title.textContent = action.label || presentation.title
  const meta = document.createElement('small')
  meta.textContent = [presentation.detail, formatSize(action.size), downloadTrustLabel(action)].filter(Boolean).join(' · ')
  copy.append(label, title, meta)
  const actions = document.createElement('div')
  actions.className = 'download-card-actions'
  const primaryLink = document.createElement('a')
  primaryLink.href = action.url
  primaryLink.rel = 'noreferrer'
  primaryLink.textContent = downloadLabel(action)
  primaryLink.setAttribute('aria-label', downloadLabel(action))
  actions.append(primaryLink)
  if (action.fallbackUrl && action.fallbackUrl !== action.url) {
    const githubLink = document.createElement('a')
    githubLink.className = 'github-fallback'
    githubLink.href = action.fallbackUrl
    githubLink.target = '_blank'
    githubLink.rel = 'noreferrer'
    githubLink.textContent = 'GitHub'
    githubLink.setAttribute('aria-label', `通过 GitHub 下载 ${definition.label}`)
    actions.append(githubLink)
  }
  article.append(copy, actions)
  return article
}

const pendingRecommended = () => {
  const fragment = document.createDocumentFragment()
  const icon = document.createElement('span')
  icon.className = 'recommended-icon'
  icon.innerHTML = '<i data-lucide="package-open"></i>'
  const copy = document.createElement('div')
  copy.innerHTML = '<small>正式版本</small><strong>首个版本准备中</strong><p>发布后显示适用版本。</p>'
  fragment.append(icon, copy)
  return fragment
}

const renderRecommended = (action: DownloadAction | undefined, choices: DownloadAction[] = []) => {
  document.querySelectorAll<HTMLElement>('[data-recommended-download]').forEach((container) => {
    container.replaceChildren()
    if (choices.length > 1) {
      const icon = document.createElement('span')
      icon.className = 'recommended-icon'
      icon.innerHTML = '<i data-lucide="monitor"></i>'
      const copy = document.createElement('div')
      copy.innerHTML = '<small>macOS</small><strong>选择适合这台 Mac 的版本</strong><p>M1 及更新机型选择 Apple 芯片；旧款机型选择 Intel。</p>'
      const actions = document.createElement('div')
      actions.className = 'recommended-actions'
      choices.forEach((choice) => {
        const link = document.createElement('a')
        link.href = choice.url
        link.rel = 'noreferrer'
        link.textContent = downloadPresentation(choice).shortButton
        link.setAttribute('aria-label', downloadLabel(choice))
        actions.append(link)
      })
      container.append(icon, copy, actions)
      return
    }
    if (!action) {
      container.append(pendingRecommended())
      return
    }
    const platform = platformFor(action)
    const definition = platformDefinitions[platform]
    const presentation = downloadPresentation(action)
    const icon = document.createElement('span')
    icon.className = 'recommended-icon'
    icon.innerHTML = `<i data-lucide="${definition.icon}"></i>`
    const copy = document.createElement('div')
    const eyebrow = document.createElement('small')
    eyebrow.textContent = '推荐版本'
    const title = document.createElement('strong')
    title.textContent = action.label || presentation.title
    const detail = document.createElement('p')
    detail.textContent = [presentation.detail, formatSize(action.size), downloadTrustLabel(action)].filter(Boolean).join(' · ')
    copy.append(eyebrow, title, detail)
    const link = document.createElement('a')
    link.href = action.url
    link.rel = 'noreferrer'
    link.textContent = downloadLabel(action)
    container.append(icon, copy, link)
  })
}

const renderRelease = (catalog: ReleaseCatalog, architecture?: ArchitectureKey) => {
  const detected = detectedPlatform()
  const detectedDownloads = catalog.downloads.filter((download) => platformFor(download) === detected)
  const architectureMatch = architecture ? detectedDownloads.find((download) => architectureFor(download) === architecture) : undefined
  const choices = detected === 'darwin' && detectedDownloads.length > 1 && !architectureMatch ? detectedDownloads : []
  const recommended = architectureMatch
    ?? (choices.length ? undefined : detectedDownloads[0])
    ?? catalog.downloads.find((download) => platformFor(download) === 'web')
    ?? catalog.downloads[0]
  renderRecommended(recommended, choices)
  document.querySelectorAll<HTMLElement>('[data-download-grid]').forEach((grid) => {
    grid.replaceChildren(...catalog.downloads.map((download) => downloadCard(download, Boolean(recommended && download === recommended))))
  })
  document.querySelectorAll<HTMLElement>('[data-release-summary]').forEach((element) => { element.textContent = `v${catalog.version} · ${formatDate(catalog.publishedAt) || '正式版'}` })
  document.querySelectorAll<HTMLElement>('[data-release-title]').forEach((element) => { element.textContent = `Echora v${catalog.version}` })
  document.querySelectorAll<HTMLElement>('[data-release-detail]').forEach((element) => {
    const date = element.querySelector('span')
    const notes = element.querySelector('p')
    if (date) date.textContent = formatDate(catalog.publishedAt) || '正式版'
    if (notes) notes.textContent = parsedReleaseNotes(catalog.releaseNotes).summary
  })
  document.querySelectorAll<HTMLElement>('[data-release-article]').forEach((article) => {
    const heading = article.querySelector('h2')
    const status = article.querySelector(':scope > span')
    const notes = article.querySelector<HTMLElement>('[data-release-notes]')
    if (heading) heading.textContent = `Echora v${catalog.version}`
    if (status) status.textContent = ['正式版', formatDate(catalog.publishedAt)].filter(Boolean).join(' · ')
    if (notes) renderReleaseNotes(notes, catalog.releaseNotes)
  })
  document.querySelectorAll<HTMLElement>('[data-primary-download]').forEach((element) => { element.textContent = choices.length ? '下载 macOS' : recommended ? downloadLabel(recommended) : '下载 Echora' })
  document.querySelectorAll<HTMLAnchorElement>('[data-github-release]').forEach((link) => {
    link.hidden = !catalog.releaseUrl
    if (catalog.releaseUrl) link.href = catalog.releaseUrl
  })
  document.querySelectorAll<HTMLElement>('[data-release-nav], [data-release-section]').forEach((element) => { element.hidden = false })
  createIcons({ icons })
}

const renderPendingRelease = () => {
  renderRecommended(undefined)
  document.querySelectorAll<HTMLElement>('[data-download-grid]').forEach((grid) => grid.replaceChildren())
  document.querySelectorAll<HTMLElement>('[data-release-summary]').forEach((element) => { element.textContent = '首个公开版本准备中' })
  document.querySelectorAll<HTMLAnchorElement>('[data-github-release]').forEach((link) => { link.hidden = true })
  document.querySelectorAll<HTMLElement>('[data-release-nav], [data-release-section]').forEach((element) => { element.hidden = true })
  if (activeRoute === 'releases') location.replace('/download')
  createIcons({ icons })
}

const loadRelease = async () => {
  try {
    const response = await fetch('/v1/releases/latest', { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error('release unavailable')
    const catalog = await response.json() as ReleaseCatalog
    if (!catalog.version || !Array.isArray(catalog.downloads)) throw new Error('release invalid')
    renderRelease(catalog, await detectedArchitecture())
  } catch {
    renderPendingRelease()
  }
}

document.querySelectorAll<HTMLAnchorElement>('[data-download-jump]').forEach((anchor) => {
  if (activeRoute !== 'home') anchor.href = '/download'
})

const setupInstallationGuide = () => {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-install-tab]')]
  const panels = [...document.querySelectorAll<HTMLElement>('[data-install-panel]')]
  if (!tabs.length || !panels.length) return
  tabs.forEach((tab) => tab.addEventListener('click', () => {
    const target = tab.dataset.installTab
    tabs.forEach((item) => item.setAttribute('aria-selected', String(item === tab)))
    panels.forEach((panel) => { panel.hidden = panel.dataset.installPanel !== target })
  }))

  document.querySelectorAll<HTMLButtonElement>('[data-copy-install-command]').forEach((button) => {
    button.addEventListener('click', async () => {
      const command = 'xattr -rd com.apple.quarantine /Applications/Echora.app'
      const status = button.closest('.installation-exception')?.querySelector<HTMLElement>('[data-copy-install-status]')
      try {
        await navigator.clipboard.writeText(command)
        button.innerHTML = '<i data-lucide="check"></i><span>已复制</span>'
        if (status) status.textContent = '命令已复制。仅在确认安装包来源后执行。'
        createIcons({ icons })
        window.setTimeout(() => {
          button.innerHTML = '<i data-lucide="copy"></i><span>复制</span>'
          if (status) status.textContent = '此步骤会移除该应用的隔离标记，不适用于来源不明的安装包。'
          createIcons({ icons })
        }, 2400)
      } catch {
        if (status) status.textContent = '浏览器未允许复制，请手动选择命令。'
      }
    })
  })
}
document.querySelectorAll<HTMLAnchorElement>('[data-client-jump]').forEach((anchor) => {
  if (activeRoute !== 'home') anchor.href = '/#clients'
})

const setupHeroScenes = () => {
  const hero = document.querySelector<HTMLElement>('.hero')
  const scenes = [...document.querySelectorAll<HTMLElement>('[data-hero-scene]')]
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-hero-scene-button]')]
  if (!hero || scenes.length < 2 || scenes.length !== buttons.length) return

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  let activeIndex = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const selectScene = (index: number) => {
    activeIndex = (index + scenes.length) % scenes.length
    scenes.forEach((scene, sceneIndex) => scene.classList.toggle('is-active', sceneIndex === activeIndex))
    buttons.forEach((button, buttonIndex) => {
      const active = buttonIndex === activeIndex
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-selected', String(active))
    })
  }

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = undefined
  }
  const start = () => {
    stop()
    if (reducedMotion.matches || document.hidden) return
    timer = setInterval(() => selectScene(activeIndex + 1), 5600)
  }

  buttons.forEach((button, index) => button.addEventListener('click', () => {
    selectScene(index)
    start()
  }))
  hero.addEventListener('focusin', stop)
  hero.addEventListener('focusout', (event) => {
    if (!hero.contains(event.relatedTarget as Node | null)) start()
  })
  document.addEventListener('visibilitychange', () => document.hidden ? stop() : start())
  reducedMotion.addEventListener('change', start)
  selectScene(0)
  start()
}

const setupProductStories = () => {
  document.querySelectorAll<HTMLElement>('[data-product-story]').forEach((story) => {
    const scenes = [...story.querySelectorAll<HTMLElement>('[data-product-story-scene]')]
    const buttons = [...story.querySelectorAll<HTMLButtonElement>('[data-product-story-button]')]
    const stage = story.querySelector<HTMLElement>('[data-product-story-stage]')
    if (!stage || scenes.length < 2 || scenes.length !== buttons.length) return

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
    const compact = matchMedia('(max-width: 840px)')
    let activeIndex = 0
    let frame = 0
    const selectScene = (index: number) => {
      const nextIndex = Math.max(0, Math.min(scenes.length - 1, index))
      if (nextIndex === activeIndex && scenes[nextIndex].classList.contains('is-active')) return
      activeIndex = nextIndex
      story.style.setProperty('--story-progress', String(activeIndex / (scenes.length - 1)))
      scenes.forEach((scene, sceneIndex) => {
        const active = sceneIndex === activeIndex
        scene.classList.toggle('is-active', active)
        scene.classList.toggle('is-before', sceneIndex < activeIndex)
        scene.setAttribute('aria-hidden', String(!active && !compact.matches))
      })
      buttons.forEach((button, buttonIndex) => {
        const active = buttonIndex === activeIndex
        button.classList.toggle('is-active', active)
        button.setAttribute('aria-current', active ? 'step' : 'false')
      })
    }
    const updateFromScroll = () => {
      frame = 0
      if (compact.matches) return selectScene(0)
      const rect = story.getBoundingClientRect()
      const distance = Math.max(1, story.offsetHeight - innerHeight)
      const progress = Math.max(0, Math.min(1, -rect.top / distance))
      const index = Math.min(scenes.length - 1, Math.floor(progress * scenes.length))
      selectScene(index)
    }
    const requestUpdate = () => {
      if (!frame) frame = requestAnimationFrame(updateFromScroll)
    }
    buttons.forEach((button, index) => button.addEventListener('click', () => {
      if (compact.matches) return
      const rect = story.getBoundingClientRect()
      const storyTop = scrollY + rect.top
      const distance = Math.max(0, story.offsetHeight - innerHeight)
      scrollTo({ top: storyTop + distance * (index / (scenes.length - 1)), behavior: reducedMotion.matches ? 'auto' : 'smooth' })
    }))
    stage.addEventListener('pointermove', (event) => {
      if (compact.matches || reducedMotion.matches) return
      const rect = stage.getBoundingClientRect()
      stage.style.setProperty('--story-x', String((event.clientX - rect.left) / rect.width - .5))
      stage.style.setProperty('--story-y', String((event.clientY - rect.top) / rect.height - .5))
    })
    stage.addEventListener('pointerleave', () => {
      stage.style.setProperty('--story-x', '0')
      stage.style.setProperty('--story-y', '0')
    })
    addEventListener('scroll', requestUpdate, { passive: true })
    addEventListener('resize', requestUpdate)
    compact.addEventListener('change', requestUpdate)
    selectScene(0)
    requestUpdate()
  })
}

if (activeRoute === 'challenge') {
  void setupChallengeView()
} else {
  setupHeroScenes()
  setupProductStories()
  setupInstallationGuide()
  void setupAccountNavigation()
  setupAccountCenter()
  setupAdmin()
  void loadRelease()
}
