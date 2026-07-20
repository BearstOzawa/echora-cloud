import { ArrowDownToLine, ArrowRight, ArrowUpRight, BadgeCheck, CalendarDays, ChevronRight, Download, Globe2, LibraryBig, Monitor, MonitorDown, PackageOpen, ShieldCheck, Smartphone, Sparkles, createIcons } from 'lucide'
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

const icons = { ArrowDownToLine, ArrowRight, ArrowUpRight, BadgeCheck, CalendarDays, ChevronRight, Download, Globe2, LibraryBig, Monitor, MonitorDown, PackageOpen, ShieldCheck, Smartphone, Sparkles }
createIcons({ icons })

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
  if (location.pathname.startsWith('/privacy')) return 'privacy'
  if (location.pathname.startsWith('/releases')) return 'releases'
  if (location.pathname.startsWith('/download')) return 'download'
  return 'home'
}

const activeRoute = routeForPath()
const routeTitles: Record<string, string> = {
  home: 'Echora - 智能音乐工作空间',
  download: '下载 Echora',
  releases: 'Echora 版本与更新',
  privacy: 'Echora 隐私说明',
}
document.title = routeTitles[activeRoute]
document.querySelectorAll<HTMLElement>('[data-view]').forEach((view) => { view.hidden = view.dataset.view !== activeRoute })
document.querySelectorAll<HTMLAnchorElement>('.site-header nav a, footer nav a').forEach((link) => {
  if (link.pathname === location.pathname) link.setAttribute('aria-current', 'page')
})

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

const formatSize = (bytes?: number) => {
  if (!bytes || bytes < 1) return ''
  const megabytes = bytes / 1024 / 1024
  return `${megabytes >= 100 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`
}

const formatDate = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

const downloadLabel = (action: DownloadAction) => action.type === 'web-refresh' ? '打开 Web 版' : `下载 ${platformDefinitions[platformFor(action)].label}`

const downloadCard = (action: DownloadAction, recommended = false) => {
  const platform = platformFor(action)
  const definition = platformDefinitions[platform]
  const article = document.createElement('article')
  article.className = `download-card${recommended ? ' is-recommended' : ''}`
  const copy = document.createElement('div')
  const label = document.createElement('span')
  label.className = 'download-card-platform'
  label.textContent = definition.label
  const title = document.createElement('strong')
  title.textContent = action.label || definition.detail
  const meta = document.createElement('small')
  meta.textContent = [formatSize(action.size), action.sha256 ? '已提供校验' : '正式发布'].filter(Boolean).join(' · ')
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
  copy.innerHTML = '<small>正式版本</small><strong>首个版本准备中</strong><p>公开发布后，这里会自动显示与你设备匹配的下载。</p>'
  fragment.append(icon, copy)
  return fragment
}

const renderRecommended = (action: DownloadAction | undefined) => {
  document.querySelectorAll<HTMLElement>('[data-recommended-download]').forEach((container) => {
    container.replaceChildren()
    if (!action) {
      container.append(pendingRecommended())
      return
    }
    const platform = platformFor(action)
    const definition = platformDefinitions[platform]
    const icon = document.createElement('span')
    icon.className = 'recommended-icon'
    icon.innerHTML = `<i data-lucide="${definition.icon}"></i>`
    const copy = document.createElement('div')
    const eyebrow = document.createElement('small')
    eyebrow.textContent = '推荐版本'
    const title = document.createElement('strong')
    title.textContent = action.label || definition.label
    const detail = document.createElement('p')
    detail.textContent = [definition.detail, formatSize(action.size)].filter(Boolean).join(' · ')
    copy.append(eyebrow, title, detail)
    const link = document.createElement('a')
    link.href = action.url
    link.rel = 'noreferrer'
    link.textContent = downloadLabel(action)
    container.append(icon, copy, link)
  })
}

const renderRelease = (catalog: ReleaseCatalog) => {
  const detected = detectedPlatform()
  const recommended = catalog.downloads.find((download) => platformFor(download) === detected)
    ?? catalog.downloads.find((download) => platformFor(download) === 'web')
    ?? catalog.downloads[0]
  renderRecommended(recommended)
  document.querySelectorAll<HTMLElement>('[data-download-grid]').forEach((grid) => {
    grid.replaceChildren(...catalog.downloads.map((download) => downloadCard(download, download === recommended)))
  })
  document.querySelectorAll<HTMLElement>('[data-release-summary]').forEach((element) => { element.textContent = `v${catalog.version} · ${formatDate(catalog.publishedAt) || '正式版'}` })
  document.querySelectorAll<HTMLElement>('[data-release-title]').forEach((element) => { element.textContent = `Echora v${catalog.version}` })
  document.querySelectorAll<HTMLElement>('[data-release-detail]').forEach((element) => {
    const date = element.querySelector('span')
    const notes = element.querySelector('p')
    if (date) date.textContent = formatDate(catalog.publishedAt) || '正式版'
    if (notes) notes.textContent = catalog.releaseNotes || '包含稳定性与体验改进。'
  })
  document.querySelectorAll<HTMLElement>('[data-release-article]').forEach((article) => {
    const heading = article.querySelector('h2')
    const notes = article.querySelector('p')
    if (heading) heading.textContent = `Echora v${catalog.version}`
    if (notes) notes.textContent = catalog.releaseNotes || '包含稳定性与体验改进。'
  })
  document.querySelectorAll<HTMLElement>('[data-primary-download]').forEach((element) => { element.textContent = recommended ? downloadLabel(recommended) : '下载 Echora' })
  document.querySelectorAll<HTMLAnchorElement>('[data-github-release]').forEach((link) => {
    link.hidden = !catalog.releaseUrl
    if (catalog.releaseUrl) link.href = catalog.releaseUrl
  })
  createIcons({ icons })
}

const renderPendingRelease = () => {
  renderRecommended(undefined)
  document.querySelectorAll<HTMLElement>('[data-download-grid]').forEach((grid) => grid.replaceChildren())
  document.querySelectorAll<HTMLElement>('[data-release-summary]').forEach((element) => { element.textContent = '首个公开版本准备中' })
  document.querySelectorAll<HTMLAnchorElement>('[data-github-release]').forEach((link) => { link.hidden = true })
  createIcons({ icons })
}

const loadRelease = async () => {
  try {
    const response = await fetch('/v1/releases/latest', { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error('release unavailable')
    const catalog = await response.json() as ReleaseCatalog
    if (!catalog.version || !Array.isArray(catalog.downloads)) throw new Error('release invalid')
    renderRelease(catalog)
  } catch {
    renderPendingRelease()
  }
}

document.querySelectorAll<HTMLAnchorElement>('[data-download-jump]').forEach((anchor) => {
  if (activeRoute !== 'home') anchor.href = '/download'
})

void loadRelease()
