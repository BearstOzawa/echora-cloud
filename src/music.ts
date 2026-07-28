import { md5 } from 'js-md5'
import { HttpError, json, readJson } from './http'
import type { WorkerEnv } from './types'
import { readSystemConfig, type MusicProviderId } from './systemConfig'
import { readRuntimeCredentials } from './systemCredentials'
import type { SystemConfig } from './systemConfig'
import { ingestMusicPlaybackHealth, orderMusicProvidersByHealth, trackMusicProviderHealth } from './musicHealth'
import { issueMusicPlaybackToken } from './musicPlaybackToken'

type Source = MusicProviderId
type Quality = '128k' | '320k' | 'flac' | 'flac24bit'
type MusicInfo = Record<string, any>

const sources = new Set<Source>(['tx', 'wy', 'kw', 'mg', 'kg'])
const qualities = new Set<Quality>(['128k', '320k', 'flac', 'flac24bit'])
const browserHeaders = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36' }
const mobileBrowserHeaders = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' }
const resolvedUrlLifetimeMs = 3 * 60_000
const miguDeviceId = '963B7AA0D21511ED807EE5846EC87D20'

const providerNames: Record<Source, string> = { tx: 'QQ 音乐', wy: '网易云', kw: '酷我', mg: '咪咕', kg: '酷狗' }
const chartDefinitions: Record<Source, Array<[string, string]>> = {
  tx: [['26', '巅峰榜·热歌'], ['62', '巅峰榜·飙升'], ['27', '巅峰榜·新歌'], ['4', '巅峰榜·流行指数']],
  wy: [['19723756', '飙升榜'], ['3779629', '新歌榜'], ['3778678', '热歌榜'], ['2884035', '原创榜']],
  kw: [['16', '酷我热歌榜'], ['93', '酷我飙升榜'], ['17', '酷我新歌榜'], ['187', '流行趋势榜']],
  kg: [['8888', 'TOP500'], ['6666', '飙升榜'], ['82831', '网络热歌榜'], ['52144', '短视频热歌榜']],
  mg: [['27553319', '尖叫新歌榜'], ['27186466', '尖叫热歌榜'], ['27553408', '尖叫原创榜'], ['75959118', '音乐风向榜']],
}

const timeoutSignal = (milliseconds = 15_000) => AbortSignal.timeout(milliseconds)

const within = <T,>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), milliseconds)
  promise.then(
    (value) => { clearTimeout(timer); resolve(value) },
    (error) => { clearTimeout(timer); reject(error) },
  )
})

const fetchJson = async (url: string | URL, init: RequestInit = {}) => {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: init.signal || timeoutSignal() })
      const text = await response.text()
      let data: any
      try { data = JSON.parse(text) } catch { data = text }
      if (!response.ok) {
        const error = new HttpError(502, '音乐平台暂时无法响应', 'music_upstream_error', { upstreamStatus: response.status })
        if (response.status < 500 && response.status !== 429) throw error
        lastError = error
        continue
      }
      return data
    } catch (error) {
      lastError = error
      if (error instanceof HttpError && error.detail?.upstreamStatus && Number(error.detail.upstreamStatus) < 500 && Number(error.detail.upstreamStatus) !== 429) throw error
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }
  if (lastError instanceof HttpError) throw lastError
  throw new HttpError(502, '音乐平台连接失败', 'music_upstream_error')
}

const formatInterval = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.round(seconds % 60).toString().padStart(2, '0')}`

const qualityInfo = (sizes: Partial<Record<Quality, number>>, hashes: Partial<Record<Quality, string>> = {}) => {
  const order: Quality[] = ['128k', '320k', 'flac', 'flac24bit']
  const available = order.filter((quality) => (sizes[quality] || 0) > 0)
  const normalized = available.length ? available : ['128k'] as Quality[]
  const size = (bytes: number) => bytes > 1 ? `${Number((bytes / 1024 / 1024).toFixed(2))}Mb` : null
  return {
    qualities: normalized,
    types: normalized.map((type) => ({ type, size: size(sizes[type] || 0), ...(hashes[type] ? { hash: hashes[type] } : {}) })),
    _types: Object.fromEntries(normalized.map((type) => [type, { size: size(sizes[type] || 0), ...(hashes[type] ? { hash: hashes[type] } : {}) }])),
  }
}

const searchQq = async (query: string, limit: number) => {
  const url = new URL('https://c.y.qq.com/soso/fcgi-bin/client_search_cp')
  Object.entries({ p: '1', n: String(limit), w: query, format: 'json', new_json: '1' }).forEach(([key, value]) => url.searchParams.set(key, value))
  const data = await fetchJson(url, { headers: { ...browserHeaders, Referer: 'https://y.qq.com/' } })
  return (Array.isArray(data?.data?.song?.list) ? data.data.song.list : []).flatMap((item: any) => {
    if (!item?.mid || !item?.file?.media_mid) return []
    const sizes = { '128k': Number(item.file.size_128mp3 || item.file.size_128 || 0), '320k': Number(item.file.size_320mp3 || item.file.size_320 || 0), flac: Number(item.file.size_flac || 0), flac24bit: Number(item.file.size_hires || 0) }
    const info = qualityInfo(sizes)
    const artist = Array.isArray(item.singer) ? item.singer.map((singer: any) => singer.name).filter(Boolean).join('、') : ''
    const albumMid = item.album?.mid || ''
    const durationSeconds = Number(item.interval || 0)
    const cover = albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg` : null
    return [{ source: 'tx', title: String(item.name || item.title || ''), artist, album: String(item.album?.name || ''), durationSeconds, cover, sizeBytesByQuality: sizes, ...info, musicInfo: { songmid: item.mid, songId: item.id, name: String(item.name || ''), singer: artist, albumName: String(item.album?.name || ''), albumId: item.album?.id || '', albumMid, strMediaMid: item.file.media_mid, source: 'tx', interval: formatInterval(durationSeconds), img: cover, types: info.types, _types: info._types, typeUrl: {} } }]
  })
}

const mapNeteaseCatalogTrack = (item: any) => {
  if (item?.id == null) return null
  const artist = Array.isArray(item.artists) ? item.artists.map((value: any) => value.name).filter(Boolean).join('、') : ''
  const durationSeconds = Number(item.duration || 0) / 1000
  const sizes = {
    '128k': Number(item.lMusic?.size || item.bMusic?.size || 1),
    '320k': Number(item.hMusic?.size || 0),
    flac: Number(item.sqMusic?.size || 0),
    flac24bit: Number(item.hrMusic?.size || 0),
  }
  const info = qualityInfo(sizes)
  const cover = item.album?.picUrl || item.album?.blurPicUrl || null
  return { source: 'wy', title: String(item.name || ''), artist, album: String(item.album?.name || ''), durationSeconds, cover, sizeBytesByQuality: sizes, ...info, musicInfo: { songmid: item.id, name: String(item.name || ''), singer: artist, albumName: String(item.album?.name || ''), albumId: item.album?.id || '', source: 'wy', interval: formatInterval(durationSeconds), img: cover, types: info.types, _types: info._types, typeUrl: {} } }
}

const fetchNeteaseChartTracks = async (boardId: string, limit: number) => {
  const data = await fetchJson(`https://music.163.com/api/playlist/detail?id=${encodeURIComponent(boardId)}&n=${limit}`, { headers: { ...browserHeaders, Referer: 'https://music.163.com/' } })
  return (Array.isArray(data?.result?.tracks) ? data.result.tracks.slice(0, limit) : []).flatMap((item: any) => {
    const track = mapNeteaseCatalogTrack(item)
    return track ? [track] : []
  })
}

const neteaseEditorialQueries = new Set(['华语流行', '新歌', '欧美流行', '轻音乐', '夜曲', '现场', '经典', '粤语金曲', '独立民谣', '电影原声', '热门'])
let neteaseChartSnapshot: { tracks: any[]; expiresAt: number } | null = null
let neteaseChartSnapshotRequest: Promise<any[]> | null = null

const loadNeteaseChartSnapshot = async () => {
  if (neteaseChartSnapshot && neteaseChartSnapshot.expiresAt > Date.now()) return neteaseChartSnapshot.tracks
  neteaseChartSnapshotRequest ??= Promise.allSettled([
    fetchNeteaseChartTracks('3778678', 50),
    fetchNeteaseChartTracks('3779629', 50),
  ]).then((results) => {
    const tracks = uniqueCrossProviderTracks(results.flatMap((result) => result.status === 'fulfilled' ? result.value : []))
    if (tracks.length) neteaseChartSnapshot = { tracks, expiresAt: Date.now() + 5 * 60_000 }
    return tracks
  }).finally(() => { neteaseChartSnapshotRequest = null })
  return neteaseChartSnapshotRequest
}

const searchNeteaseCharts = async (query: string, limit: number) => {
  const tracks = await loadNeteaseChartSnapshot()
  const normalizedQuery = normalizedTrackIdentity(query)
  const matches = tracks.filter((track) => normalizedTrackIdentity(`${track.title}${track.artist}${track.album}`).includes(normalizedQuery))
  if (matches.length) return matches.slice(0, limit)
  if (!neteaseEditorialQueries.has(query)) return []
  const offset = tracks.length ? [...query].reduce((sum, character) => sum + character.charCodeAt(0), 0) % tracks.length : 0
  return [...tracks.slice(offset), ...tracks.slice(0, offset)].slice(0, limit)
}

const searchNetease = async (query: string, limit: number) => {
  const url = new URL('https://music.163.com/api/search/get/web')
  Object.entries({ s: query, type: '1', offset: '0', total: 'true', limit: String(limit) }).forEach(([key, value]) => url.searchParams.set(key, value))
  let directError: unknown
  try {
    const data = await fetchJson(url, { headers: { ...browserHeaders, Referer: 'https://music.163.com/', Cookie: 'os=pc; appver=2.9.7', Accept: 'application/json, text/plain, */*', 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    const tracks = (Array.isArray(data?.result?.songs) ? data.result.songs : []).flatMap((item: any) => {
      const track = mapNeteaseCatalogTrack(item)
      return track ? [track] : []
    })
    if (tracks.length) return tracks
  } catch (error) {
    directError = error
  }
  const fallback = await searchNeteaseCharts(query, limit).catch(() => [])
  if (fallback.length) return fallback
  if (directError) throw directError
  return []
}

const searchKuwo = async (query: string, limit: number) => {
  const url = new URL('https://search.kuwo.cn/r.s')
  Object.entries({ client: 'kt', all: query, pn: '0', rn: String(limit), uid: '794762570', ver: 'kwplayer_ar_9.2.2.1', vipver: '1', show_copyright_off: '1', newver: '1', ft: 'music', cluster: '0', strategy: '2012', encoding: 'utf8', rformat: 'json', vermerge: '1', mobi: '1', issubtitle: '1' }).forEach(([key, value]) => url.searchParams.set(key, value))
  const data = await fetchJson(url, { headers: browserHeaders })
  return (Array.isArray(data?.abslist) ? data.abslist : []).flatMap((item: any) => {
    const songmid = String(item?.MUSICRID || '').replace(/^MUSIC_/, '')
    if (!songmid) return []
    const formats = String(item.N_MINFO || '')
    const sizes = { '128k': formats.includes('bitrate:128') ? 1 : 0, '320k': formats.includes('bitrate:320') ? 1 : 0, flac: formats.includes('bitrate:2000') ? 1 : 0, flac24bit: formats.includes('bitrate:4000') ? 1 : 0 }
    const info = qualityInfo(sizes)
    const durationSeconds = Number(item.DURATION || 0)
    const coverPath = String(item.web_albumpic_short || item.web_artistpic_short || '').replace(/^\/+/, '').replace(/^120\//, '')
    const cover = coverPath ? `https://img1.kuwo.cn/star/albumcover/500/${coverPath}` : null
    return [{ source: 'kw', title: String(item.SONGNAME || ''), artist: String(item.ARTIST || ''), album: String(item.ALBUM || ''), durationSeconds, cover, sizeBytesByQuality: sizes, ...info, musicInfo: { songmid, name: String(item.SONGNAME || ''), singer: String(item.ARTIST || ''), albumName: String(item.ALBUM || ''), albumId: item.ALBUMID || '', source: 'kw', interval: formatInterval(durationSeconds), img: cover, types: info.types, _types: info._types, typeUrl: {} } }]
  })
}

const miguFormats = (item: any) => [
  ...(Array.isArray(item?.audioFormats) ? item.audioFormats : []),
  ...(Array.isArray(item?.rateFormats) ? item.rateFormats : []),
  ...(Array.isArray(item?.newRateFormats) ? item.newRateFormats : []),
]

const miguQualitySizes = (item: any) => {
  const sizes: Partial<Record<Quality, number>> = {}
  for (const format of miguFormats(item)) {
    const type = String(format?.formatType || format?.resourceType || '').toUpperCase()
    const bytes = Number(format?.size || format?.asize || format?.isize || 1)
    if (type.includes('ZQ24') || type.includes('24BIT')) sizes.flac24bit = bytes
    else if (type.includes('SQ') || type.includes('LOSSLESS')) sizes.flac = bytes
    else if (type.includes('HQ') || type.includes('320')) sizes['320k'] = bytes
    else if (type.includes('PQ') || type.includes('128')) sizes['128k'] = bytes
  }
  return sizes
}

const isResolvableMiguCatalogEntry = (item: any) => {
  return Boolean(item?.songId && item?.copyrightId && item?.contentId && miguFormats(item).length)
}

const searchMigu = async (query: string, limit: number) => {
  const timestamp = Date.now().toString()
  const deviceId = '963B7AA0D21511ED807EE5846EC87D20'
  const sign = md5(`${query}6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${timestamp}`)
  const url = new URL('https://jadeite.migu.cn/music_search/v3/search/searchAll')
  Object.entries({ isCorrect: '0', isCopyright: '1', searchSwitch: '{"song":1,"album":0,"singer":0,"tagSong":1,"mvSong":0,"bestShow":1,"songlist":0,"lyricSong":0}', pageSize: String(limit), text: query, pageNo: '1', sort: '0', sid: 'USS' }).forEach(([key, value]) => url.searchParams.set(key, value))
  const data = await fetchJson(url, { headers: { ...browserHeaders, uiVersion: 'A_music_3.6.1', deviceId, timestamp, sign, channel: '0146921' } })
  const list = (Array.isArray(data?.songResultData?.resultList) ? data.songResultData.resultList : []).flat().slice(0, limit)
  return list.flatMap((item: any) => {
    if (!isResolvableMiguCatalogEntry(item)) return []
    const sizes = miguQualitySizes(item)
    if (!sizes['128k']) sizes['128k'] = 1
    const info = qualityInfo(sizes)
    const artist = Array.isArray(item.singerList) ? item.singerList.map((singer: any) => singer.name).filter(Boolean).join('、') : ''
    const durationSeconds = Number(item.duration || 0)
    const rawCover = item.img3 || item.img2 || item.img1
    const cover = rawCover ? (/^https?:/.test(rawCover) ? rawCover : `https://d.musicapp.migu.cn${rawCover}`) : null
    return [{ source: 'mg', title: String(item.name || ''), artist, album: String(item.album || ''), durationSeconds, cover, sizeBytesByQuality: sizes, ...info, musicInfo: { songmid: item.songId, contentId: item.contentId, copyrightId: item.copyrightId, name: String(item.name || ''), singer: artist, albumName: String(item.album || ''), albumId: item.albumId || '', source: 'mg', interval: formatInterval(durationSeconds), img: cover, lrcUrl: item.lrcUrl, mrcUrl: item.mrcurl, trcUrl: item.trcUrl, types: info.types, _types: info._types, typeUrl: {} } }]
  })
}

type KugouCatalogAccess = 'playable' | 'blocked' | 'unknown'

const kugouCatalogAccess = (item: any): KugouCatalogAccess => {
  const rawPayType = item?.PayType ?? item?.pay_type
  const rawPrice = item?.Price ?? item?.price
  const freeLimited = Number(item?.trans_param?.free_limited ?? 0) === 1
  if (freeLimited) return 'playable'
  if (rawPayType == null && rawPrice == null) return 'unknown'
  return Number(rawPayType ?? 0) <= 0 && Number(rawPrice ?? 0) <= 0 ? 'playable' : 'blocked'
}

const kugouCatalogHash = (item: any) => String(item?.FileHash || item?.hash || '').trim()

const hasKugouPlaybackUrl = (data: any) => /^https?:\/\//i.test(String(data?.url || data?.data?.url || ''))

const fetchKugouPlaybackMetadata = async (httpsUrl: string, timeoutMs = 8_000) => {
  let lastData: any = null
  let lastError: unknown
  let lastUpstreamStatus = 0
  for (const protocol of ['https:', 'http:'] as const) {
    const url = new URL(httpsUrl)
    url.protocol = protocol
    try {
      const data = await fetchJson(url.toString(), {
        headers: { ...browserHeaders, Referer: 'https://www.kugou.com/' },
        signal: timeoutSignal(timeoutMs),
      })
      lastData = data
      if (hasKugouPlaybackUrl(data)) return data
    } catch (error) {
      lastError = error
      const upstreamStatus = Number((error as { detail?: { upstreamStatus?: unknown } })?.detail?.upstreamStatus || 0)
      if (upstreamStatus) lastUpstreamStatus = upstreamStatus
    }
  }
  if (lastData != null) return lastData
  if (lastUpstreamStatus) throw new HttpError(502, '音乐平台暂时无法响应', 'music_upstream_error', { upstreamStatus: lastUpstreamStatus })
  if (lastError instanceof HttpError) throw lastError
  throw lastError ?? new HttpError(502, '音乐平台连接失败', 'music_upstream_error')
}

const probeKugouCatalogEntry = async (item: any) => {
  const hash = kugouCatalogHash(item)
  if (!hash) return false
  try {
    const data = await fetchKugouPlaybackMetadata(
      `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash.toLocaleUpperCase())}`,
      2_500,
    )
    return hasKugouPlaybackUrl(data) && Number(data?.timeLength || 0) > 0
  } catch {
    return false
  }
}

const filterPlayableKugouCatalogEntries = async (items: any[], limit: number) => {
  const candidates = items.filter((item) => kugouCatalogHash(item)).slice(0, 36)
  const playable: any[] = []
  const batchSize = 12
  const startedAt = Date.now()
  for (let offset = 0; offset < candidates.length && playable.length < limit; offset += batchSize) {
    if (offset > 0 && Date.now() - startedAt > 4_500) break
    const batch = candidates.slice(offset, offset + batchSize)
    const checks = await Promise.all(batch.map(async (item) => {
      const access = kugouCatalogAccess(item)
      if (access === 'blocked') return false
      if (access === 'playable') return true
      return probeKugouCatalogEntry(item)
    }))
    batch.forEach((item, index) => { if (checks[index]) playable.push(item) })
  }
  return playable.slice(0, limit)
}

const searchKugou = async (query: string, limit: number) => {
  const catalogLimit = Math.min(100, Math.max(limit, limit * 3))
  const url = new URL('https://songsearch.kugou.com/song_search_v2')
  Object.entries({ keyword: query, page: '1', pagesize: String(catalogLimit), platform: 'WebFilter', userid: '0', clientver: '2000', iscorrection: '1', privilege_filter: '0', filter: '10' }).forEach(([key, value]) => url.searchParams.set(key, value))
  const data = await fetchJson(url, { headers: { ...browserHeaders, Referer: 'https://www.kugou.com/' } })
  const entries = await filterPlayableKugouCatalogEntries(Array.isArray(data?.data?.lists) ? data.data.lists : [], limit)
  return entries.flatMap((item: any) => {
    const hash = String(item?.FileHash || '').trim()
    if (!hash) return []
    const sizes = { '128k': Number(item.FileSize || 1) }
    const hashes = { '128k': hash }
    const info = qualityInfo(sizes, hashes)
    const durationSeconds = Number(item.Duration || 0)
    const coverTemplate = String(item.Image || item.AlbumPrivilege?.image || '')
    const cover = coverTemplate ? coverTemplate.replace('{size}', '500') : null
    return [{ source: 'kg', title: String(item.SongName || item.OriSongName || ''), artist: String(item.SingerName || ''), album: String(item.AlbumName || ''), durationSeconds, cover, sizeBytesByQuality: sizes, ...info, musicInfo: { songmid: item.Audioid || item.MixSongID || hash, hash, name: String(item.SongName || ''), singer: String(item.SingerName || ''), albumName: String(item.AlbumName || ''), albumId: item.AlbumID || '', source: 'kg', interval: formatInterval(durationSeconds), img: cover, types: info.types, _types: info._types, typeUrl: {} } }]
  }).slice(0, limit)
}

const searchers: Record<Source, (query: string, limit: number) => Promise<any[]>> = { tx: searchQq, wy: searchNetease, kw: searchKuwo, mg: searchMigu, kg: searchKugou }

const interleaveGroups = <T,>(groups: T[][]) => {
  const values: T[] = []
  const maximumLength = Math.max(0, ...groups.map((group) => group.length))
  for (let index = 0; index < maximumLength; index += 1) {
    for (const group of groups) {
      if (group[index] !== undefined) values.push(group[index])
    }
  }
  return values
}

const normalizedTrackIdentity = (value: unknown) => String(value || '').toLocaleLowerCase().replace(/[\s·・,.，。'"“”‘’()（）\[\]【】_-]/g, '')
const uniqueCrossProviderTracks = <T extends { title?: unknown; artist?: unknown }>(tracks: T[]) => {
  const seen = new Set<string>()
  return tracks.filter((track) => {
    const primaryArtist = String(track.artist || '').split(/[、/&，,]+/)[0]
    const key = `${normalizedTrackIdentity(track.title)}:${normalizedTrackIdentity(primaryArtist)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const parseSources = (value: string | null, config: SystemConfig) => {
  const enabled = new Set(config.music.enabledProviders)
  const requested = new Set((value || config.music.preferredSourceOrder.join(',')).split(',').filter((source): source is Source => sources.has(source as Source)))
  return config.music.preferredSourceOrder.filter((source): source is Source => enabled.has(source) && requested.has(source))
}

const searchRequest = async (request: Request, env: WorkerEnv, config: SystemConfig, execution?: ExecutionContext) => {
  const url = new URL(request.url)
  const query = (url.searchParams.get('query') || '').trim().slice(0, 80)
  if (!query) throw new HttpError(400, '请输入搜索内容', 'missing_query')
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || 20) || 20))
  const selected = await orderMusicProvidersByHealth(env, 'search', parseSources(url.searchParams.get('sources'), config))
  if (!selected.length) throw new HttpError(503, '暂无可用的音乐平台', 'music_service_unavailable')
  const results = await Promise.allSettled(selected.map(async (source) => {
    const startedAt = Date.now()
    try {
      const tracks = await within(searchers[source](query, limit), 8_000, `${providerNames[source]}搜索超时`)
      await trackMusicProviderHealth(env, { providerId: source, operation: 'search', outcome: 'success', latencyMs: Date.now() - startedAt }, execution)
      return { source, tracks }
    } catch (error) {
      await trackMusicProviderHealth(env, { providerId: source, operation: 'search', outcome: 'error', latencyMs: Date.now() - startedAt, error }, execution)
      throw error
    }
  }))
  const tracks = uniqueCrossProviderTracks(interleaveGroups(results.flatMap((result) => result.status === 'fulfilled' ? [result.value.tracks] : [])))
  const sourceStatuses = results.map((result, index) => result.status === 'fulfilled'
    ? { source: selected[index], status: result.value.tracks.length ? 'available' : 'empty', message: result.value.tracks.length ? `已返回 ${result.value.tracks.length} 首` : '服务已响应，暂无匹配结果' }
    : { source: selected[index], status: 'error', message: '内容服务暂时不可用' })
  if (!tracks.length) throw new HttpError(502, '音乐平台暂时没有返回结果', 'catalog_unavailable', { sourceStatuses })
  return json(request, env, { tracks, sourceStatuses }, 200, { 'Cache-Control': 'public, max-age=60' })
}

const chartCatalogRequest = async (request: Request, env: WorkerEnv, config: SystemConfig) => {
  const selected = await orderMusicProvidersByHealth(env, 'chart', parseSources(new URL(request.url).searchParams.get('sources'), config))
  const charts = selected.flatMap((source) => chartDefinitions[source].map(([boardId, name]) => ({ id: `${source}:${boardId}`, boardId, source, name, description: `${providerNames[source]}榜单`, updatedAt: '', cover: null, updateFrequency: '', preview: [] })))
  return json(request, env, { charts }, 200, { 'Cache-Control': 'public, max-age=600' })
}

const chartDetailCore = async (request: Request, env: WorkerEnv, source: Source, boardId: string, config: SystemConfig) => {
  if (!config.music.enabledProviders.includes(source)) throw new HttpError(503, `${providerNames[source]}当前不参与聚合`, 'music_provider_disabled')
  const limit = Math.max(1, Math.min(100, Number(new URL(request.url).searchParams.get('limit') || 50) || 50))
  const fallbackName = chartDefinitions[source].find(([id]) => id === boardId)?.[1] || `${providerNames[source]}榜单`
  let name = fallbackName
  let updatedAt = ''
  let tracks: any[] = []
  if (source === 'tx') {
    const url = new URL('https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg')
    Object.entries({ topid: boardId, tpl: '3', page: 'detail', type: 'top', song_begin: '0', song_num: String(limit), g_tk: '5381', format: 'json' }).forEach(([key, value]) => url.searchParams.set(key, value))
    const data = await fetchJson(url, { headers: { ...browserHeaders, Referer: 'https://y.qq.com/' } })
    name = String(data?.topinfo?.ListName || data?.topinfo?.listName || fallbackName)
    updatedAt = String(data?.date || '')
    tracks = (Array.isArray(data?.songlist) ? data.songlist : []).flatMap((entry: any) => {
      const item = entry?.data
      if (!item?.songmid) return []
      const sizes = { '128k': Number(item.size128 || 0), '320k': Number(item.size320 || 0), flac: Number(item.sizeflac || 0), flac24bit: Number(item.sizehires || 0) }
      const q = qualityInfo(sizes)
      const artist = Array.isArray(item.singer) ? item.singer.map((value: any) => value.name).filter(Boolean).join('、') : ''
      const durationSeconds = Number(item.interval || 0)
      const cover = item.albummid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${item.albummid}.jpg` : null
      return [{ source, title: String(item.songname || ''), artist, album: String(item.albumname || ''), durationSeconds, cover, sizeBytesByQuality: sizes, qualities: q.qualities, musicInfo: { songmid: item.songmid, songId: item.songid, name: String(item.songname || ''), singer: artist, albumName: String(item.albumname || ''), albumId: item.albumid || '', albumMid: item.albummid || '', strMediaMid: item.strMediaMid || item.songmid, source, interval: formatInterval(durationSeconds), img: cover, types: q.types, _types: q._types, typeUrl: {} } }]
    })
  } else if (source === 'wy') {
    const data = await fetchJson(`https://music.163.com/api/playlist/detail?id=${encodeURIComponent(boardId)}&n=${limit}`, { headers: { ...browserHeaders, Referer: 'https://music.163.com/' } })
    const playlist = data?.result
    name = String(playlist?.name || fallbackName)
    updatedAt = playlist?.updateTime ? new Date(Number(playlist.updateTime)).toISOString().slice(0, 10) : ''
    tracks = (Array.isArray(playlist?.tracks) ? playlist.tracks.slice(0, limit) : []).flatMap((item: any) => {
      const track = mapNeteaseCatalogTrack(item)
      return track ? [track] : []
    })
  } else if (source === 'kw') {
    const data = await fetchJson(`https://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&pn=0&rn=${limit}&type=bang&data=content&id=${encodeURIComponent(boardId)}`, { headers: browserHeaders })
    name = String(data?.name || data?.title || fallbackName)
    updatedAt = String(data?.pub || '')
    tracks = (Array.isArray(data?.musiclist) ? data.musiclist : []).flatMap((item: any) => {
      if (item?.id == null) return []
      const sizes = { '128k': 1, '320k': 1, flac: String(item.formats || '').includes('ALFLAC') ? 1 : 0, flac24bit: 0 }
      const q = qualityInfo(sizes)
      const durationSeconds = Number(item.song_duration || item.duration || 0)
      return [{ source, title: String(item.name || ''), artist: String(item.artist || ''), album: String(item.album || ''), durationSeconds, cover: null, sizeBytesByQuality: sizes, qualities: q.qualities, musicInfo: { songmid: String(item.id), name: String(item.name || ''), singer: String(item.artist || ''), albumName: String(item.album || ''), albumId: item.albumid || '', source, interval: formatInterval(durationSeconds), img: null, types: q.types, _types: q._types, typeUrl: {} } }]
    })
  } else if (source === 'kg') {
    // This legacy catalog host presents a mismatched TLS certificate. The
    // payload is public metadata, so Cloud fetches its supported HTTP origin.
    const catalogLimit = Math.min(100, Math.max(limit, limit * 3))
    const data = await fetchJson(`http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=1&plat=0&pagesize=${catalogLimit}&area_code=1&page=1&rankid=${encodeURIComponent(boardId)}&with_res_tag=0&show_portrait_mv=1`, { headers: { ...browserHeaders, Referer: 'https://www.kugou.com/' } })
    name = String(data?.data?.rankinfo?.rankname || fallbackName)
    const entries = await filterPlayableKugouCatalogEntries(Array.isArray(data?.data?.info) ? data.data.info : [], limit)
    tracks = entries.flatMap((item: any) => {
      const hash = String(item?.hash || '').trim()
      if (!hash) return []
      const sizes = { '128k': Number(item.filesize || 1) }
      const hashes = { '128k': hash }
      const q = qualityInfo(sizes, hashes)
      const artist = Array.isArray(item.authors) ? item.authors.map((value: any) => value.author_name).filter(Boolean).join('、') : String(item.singername || '')
      const durationSeconds = Number(item.duration || 0)
      const rawCover = String(item.album_sizable_cover || item.albumpic || '')
      const cover = rawCover ? rawCover.replace('{size}', '500') : null
      return [{ source, title: String(item.songname || item.filename || ''), artist, album: String(item.remark || item.album_name || ''), durationSeconds, cover, sizeBytesByQuality: sizes, qualities: q.qualities, musicInfo: { songmid: item.audio_id || item.album_audio_id || hash, hash, name: String(item.songname || ''), singer: artist, albumName: String(item.remark || ''), albumId: item.album_id || '', source, interval: formatInterval(durationSeconds), img: cover, types: q.types, _types: q._types, typeUrl: {} } }]
    }).slice(0, limit)
  } else {
    const data = await fetchJson(`https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/querycontentbyId.do?columnId=${encodeURIComponent(boardId)}&needAll=0`, { headers: browserHeaders })
    const column = data?.data?.columnInfo || data?.columnInfo
    name = String(column?.columnTitle || fallbackName)
    updatedAt = String(column?.columnUpdateTime || '')
    const entries = (Array.isArray(column?.contents) ? column.contents : []).slice(0, limit)
    tracks = entries.flatMap((entry: any) => {
      const item = entry?.objectInfo || entry
      if (!isResolvableMiguCatalogEntry(item)) return []
      const sizes = miguQualitySizes(item)
      if (!sizes['128k']) sizes['128k'] = 1
      const q = qualityInfo(sizes)
      const artist = Array.isArray(item.singers) ? item.singers.map((value: any) => value?.name).filter(Boolean).join('、') : String(item.singer || '')
      const durationSeconds = typeof item.duration === 'number' ? item.duration : 0
      const rawCover = item.img3 || item.img2 || item.img1
      const cover = rawCover ? (/^https?:/.test(rawCover) ? rawCover : `https://d.musicapp.migu.cn${rawCover}`) : null
      return [{ source, title: String(item.songName || item.name || ''), artist, album: String(item.album || item.albumName || ''), durationSeconds, cover, sizeBytesByQuality: sizes, qualities: q.qualities, musicInfo: { songmid: item.songId, contentId: item.contentId, copyrightId: item.copyrightId, name: String(item.songName || item.name || ''), singer: artist, albumName: String(item.album || item.albumName || ''), albumId: item.albumId || '', source, interval: formatInterval(durationSeconds), img: cover, lrcUrl: item.lrcUrl, mrcUrl: item.mrcUrl, trcUrl: item.trcUrl, types: q.types, _types: q._types, typeUrl: {} } }]
    })
  }
  if (!tracks.length) throw new HttpError(502, '榜单暂时没有返回可用歌曲', 'chart_unavailable')
  return json(request, env, { chart: { id: `${source}:${boardId}`, name, description: `${providerNames[source]}榜单`, source, updatedAt, tracks } }, 200, { 'Cache-Control': 'public, max-age=300' })
}

const chartDetailRequest = async (request: Request, env: WorkerEnv, source: Source, boardId: string, config: SystemConfig, execution?: ExecutionContext) => {
  const startedAt = Date.now()
  try {
    const response = await chartDetailCore(request, env, source, boardId, config)
    await trackMusicProviderHealth(env, { providerId: source, operation: 'chart', outcome: 'success', latencyMs: Date.now() - startedAt }, execution)
    return response
  } catch (error) {
    await trackMusicProviderHealth(env, { providerId: source, operation: 'chart', outcome: 'error', latencyMs: Date.now() - startedAt, error }, execution)
    throw error
  }
}

const recursiveUrl = (value: unknown, depth = 0): string => {
  if (depth > 4 || value == null) return ''
  if (typeof value === 'string') {
    const match = value.match(/https?:\/\/[^\s"'<>]+/)
    return match?.[0] || ''
  }
  if (Array.isArray(value)) return value.map((item) => recursiveUrl(item, depth + 1)).find(Boolean) || ''
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['url', 'playUrl', 'play_url', 'musicUrl', 'music_url', 'src']) {
      const found = recursiveUrl(record[key], depth + 1)
      if (found) return found
    }
    return Object.values(record).map((item) => recursiveUrl(item, depth + 1)).find(Boolean) || ''
  }
  return ''
}

const resolverHeaders = (source: Source): Record<string, string> => {
  if (source === 'mg') return {
    ...mobileBrowserHeaders,
    channel: '0146951',
    uid: '1234',
  }
  if (source === 'tx') return { ...browserHeaders, Referer: 'https://y.qq.com/' }
  if (source === 'wy') return { ...browserHeaders, Referer: 'https://music.163.com/', Cookie: 'os=pc; appver=2.9.7', Accept: 'application/json, text/plain, */*', 'Accept-Language': 'zh-CN,zh;q=0.9' }
  if (source === 'kw') return { ...browserHeaders, Referer: 'https://www.kuwo.cn/' }
  return { ...browserHeaders, Referer: 'https://www.kugou.com/' }
}

const resolvedMediaUrl = (source: Source, data: unknown) => {
  const record = data && typeof data === 'object' ? data as Record<string, any> : {}
  const explicit = source === 'kw'
    ? record.data?.url
    : source === 'mg'
      ? record.data?.url || record.resource?.[0]?.url
      : source === 'tx'
        ? record.data?.music || record.data?.url || record.url
        : record.url || record.data?.url
  const resolved = recursiveUrl(explicit) || recursiveUrl(data)
  return resolved.replace(/^http:\/\//i, 'https://')
}

const resolverUrl = (source: Source, quality: Quality, musicInfo: MusicInfo, musicResolverKey: string) => {
  const songmid = encodeURIComponent(String(musicInfo.songmid || musicInfo.songId || ''))
  if (!songmid) throw new HttpError(400, '歌曲缺少解析标识', 'missing_track_identifier')
  if (source === 'tx') {
    if (!musicResolverKey) throw new HttpError(503, 'Echora 音乐解析尚未完成配置', 'music_resolver_unavailable')
    const labels: Record<Quality, string> = { '128k': '低品质', '320k': 'HQ高品质', flac: 'SQ无损', flac24bit: '臻品全景声' }
    return `https://api-v2.yuafeng.cn/API/qqmusic.php?type=${encodeURIComponent(labels[quality])}&mid=${songmid}&apikey=${encodeURIComponent(musicResolverKey)}`
  }
  if (source === 'wy') {
    const levels: Record<Quality, string> = { '128k': 'standard', '320k': 'exhigh', flac: 'lossless', flac24bit: 'hires' }
    return `https://api.chksz.top/api/163_music?id=${songmid}&level=${levels[quality]}`
  }
  if (source === 'kw') {
    const rates: Record<Quality, string> = { '128k': '128kmp3', '320k': '320kmp3', flac: '2000kflac', flac24bit: '4000kflac' }
    const user = Math.floor(Math.random() * 4_000_000_000)
    return `https://nmobi.kuwo.cn/mobi.s?f=web&source=kwplayercar_ar_6.0.0.9_B_jiakong_vh.apk&type=convert_url_with_sign&rid=${songmid}&br=${rates[quality]}&user=${user}&loginUid=${user}`
  }
  if (source === 'kg') {
    const preferredHash = musicInfo?._types?.[quality]?.hash || musicInfo.hash || songmid
    return `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(String(preferredHash).toLocaleUpperCase())}`
  }
  const copyrightId = encodeURIComponent(String(musicInfo.copyrightId || ''))
  const contentId = encodeURIComponent(String(musicInfo.contentId || ''))
  if (!copyrightId || !contentId) throw new HttpError(422, '咪咕歌曲信息已过期，请重新选择', 'stale_track_metadata')
  const rates: Record<Quality, string> = { '128k': 'PQ', '320k': 'HQ', flac: 'SQ', flac24bit: 'ZQ24' }
  return `https://app.c.nf.migu.cn/MIGUM3.0/strategy/pc/listen/v1.0?scene=&netType=01&resourceType=2&copyrightId=${copyrightId}&contentId=${contentId}&toneFlag=${rates[quality]}`
}

const expectedDurationSeconds = (musicInfo: MusicInfo) => {
  const match = String(musicInfo.interval || '').match(/^(\d+):(\d{2})$/)
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0
}

const validateResolvedMedia = async (source: Source, url: string, musicInfo: MusicInfo) => {
  if (source !== 'kw' || expectedDurationSeconds(musicInfo) < 60) return
  try {
    const response = await fetch(url, { method: 'HEAD', headers: resolverHeaders(source), signal: timeoutSignal(8_000) })
    const contentLength = Number(response.headers.get('Content-Length') || 0)
    if (response.ok && contentLength > 0 && contentLength < 512 * 1024) {
      throw new HttpError(422, '这首歌在酷我仅返回了短提示音', 'playback_preview_only')
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    // A failed probe must not hide an otherwise usable media URL.
  }
}

const providerUnavailableMessage = (source: Source, data: unknown) => {
  if (!data || typeof data !== 'object') return ''
  const record = data as Record<string, any>
  if (source === 'mg') return String(record.data?.dialogInfo?.text || record.info || record.msg || '')
  return String(record.msg || record.message || '')
}

const resolvedQuality = (source: Source, requested: Quality, data: unknown): Quality => {
  if (source !== 'kg' || !data || typeof data !== 'object') return requested
  const record = data as Record<string, any>
  if (/flac/i.test(String(record.extName || ''))) return 'flac'
  return Number(record.bitRate || 0) >= 320 ? '320k' : '128k'
}

const qualityOrder: Quality[] = ['128k', '320k', 'flac', 'flac24bit']

const resolveRequest = async (request: Request, env: WorkerEnv, config: SystemConfig, execution?: ExecutionContext) => {
  const body = await readJson<{ source?: unknown; quality?: unknown; musicInfo?: unknown }>(request, 64 * 1024)
  const source = typeof body.source === 'string' && sources.has(body.source as Source) ? body.source as Source : null
  const quality = typeof body.quality === 'string' && qualities.has(body.quality as Quality) ? body.quality as Quality : null
  const musicInfo = body.musicInfo && typeof body.musicInfo === 'object' ? body.musicInfo as MusicInfo : null
  if (!source || !quality || !musicInfo) throw new HttpError(400, '播放解析参数不完整', 'invalid_resolve_request')
  if (!config.music.enabledProviders.includes(source)) throw new HttpError(503, `${providerNames[source]}当前不参与聚合`, 'music_provider_disabled')
  const startedAt = Date.now()
  const playbackToken = (actualQuality: Quality) => issueMusicPlaybackToken(request, env, {
    providerId: source,
    requestedQuality: quality,
    resolvedQuality: actualQuality,
  })
  try {
    const upstreamUrl = resolverUrl(source, quality, musicInfo, (await readRuntimeCredentials(env)).musicResolverKey)
    let data: unknown
    try {
      data = source === 'kg'
        ? await fetchKugouPlaybackMetadata(upstreamUrl)
        : await fetchJson(upstreamUrl, { headers: resolverHeaders(source), signal: timeoutSignal(20_000) })
    } catch (error) {
      if (source === 'tx' && error instanceof HttpError && Number(error.detail?.upstreamStatus) === 456) {
        await trackMusicProviderHealth(env, { providerId: source, operation: 'resolve', outcome: 'delegated', latencyMs: Date.now() - startedAt }, execution)
        return json(request, env, {
          source,
          resolvedQuality: quality,
          directResolver: { provider: 'qq', url: upstreamUrl },
          expiresAt: Date.now() + resolvedUrlLifetimeMs,
          latencyMs: Date.now() - startedAt,
          playbackToken: await playbackToken(quality),
        })
      }
      if (source === 'kw') {
        await trackMusicProviderHealth(env, { providerId: source, operation: 'resolve', outcome: 'delegated', latencyMs: Date.now() - startedAt }, execution)
        return json(request, env, {
          source,
          resolvedQuality: quality,
          directResolver: { provider: 'kuwo', url: upstreamUrl },
          expiresAt: Date.now() + resolvedUrlLifetimeMs,
          latencyMs: Date.now() - startedAt,
          playbackToken: await playbackToken(quality),
        })
      }
      throw error
    }
    const resolvedUrl = resolvedMediaUrl(source, data)
    if (!resolvedUrl || !/^https?:\/\//i.test(resolvedUrl)) {
      if (source === 'kw' || source === 'kg') {
        await trackMusicProviderHealth(env, { providerId: source, operation: 'resolve', outcome: 'delegated', latencyMs: Date.now() - startedAt }, execution)
        return json(request, env, {
          source,
          resolvedQuality: quality,
          directResolver: { provider: source === 'kw' ? 'kuwo' : 'kugou', url: upstreamUrl },
          expiresAt: Date.now() + resolvedUrlLifetimeMs,
          latencyMs: Date.now() - startedAt,
          playbackToken: await playbackToken(quality),
        })
      }
      const providerMessage = providerUnavailableMessage(source, data)
      throw new HttpError(422, providerMessage || '当前音质没有可用的播放地址', 'playback_url_unavailable')
    }
    await validateResolvedMedia(source, resolvedUrl, musicInfo)
    const actualQuality = resolvedQuality(source, quality, data)
    await trackMusicProviderHealth(env, {
      providerId: source,
      operation: 'resolve',
      outcome: 'success',
      latencyMs: Date.now() - startedAt,
      downgraded: qualityOrder.indexOf(actualQuality) < qualityOrder.indexOf(quality),
    }, execution)
    return json(request, env, {
      url: resolvedUrl,
      source,
      resolvedQuality: actualQuality,
      expiresAt: Date.now() + resolvedUrlLifetimeMs,
      latencyMs: Date.now() - startedAt,
      playbackToken: await playbackToken(actualQuality),
    })
  } catch (error) {
    await trackMusicProviderHealth(env, { providerId: source, operation: 'resolve', outcome: 'error', latencyMs: Date.now() - startedAt, error }, execution)
    throw error
  }
}

const lyricRequest = async (request: Request, env: WorkerEnv, config: SystemConfig) => {
  const body = await readJson<{ source?: unknown; musicInfo?: unknown }>(request, 64 * 1024)
  const source = typeof body.source === 'string' && sources.has(body.source as Source) ? body.source as Source : null
  const info = body.musicInfo && typeof body.musicInfo === 'object' ? body.musicInfo as MusicInfo : null
  if (!source || !info) throw new HttpError(400, '歌词参数不完整', 'invalid_lyric_request')
  if (!config.music.enabledProviders.includes(source)) throw new HttpError(503, `${providerNames[source]}当前不参与聚合`, 'music_provider_disabled')
  let lyric = ''
  let translation = ''
  if (source === 'wy') {
    const data = await fetchJson(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(String(info.songmid))}&lv=1&kv=1&tv=-1`, { headers: { ...browserHeaders, Referer: 'https://music.163.com/' } })
    lyric = String(data?.lrc?.lyric || '')
    translation = String(data?.tlyric?.lyric || '')
  } else if (source === 'tx') {
    const data = await fetchJson(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(String(info.songmid))}&format=json&nobase64=1`, { headers: { ...browserHeaders, Referer: 'https://y.qq.com/' } })
    lyric = String(data?.lyric || '')
    translation = String(data?.trans || '')
  } else if (source === 'kw') {
    const data = await fetchJson(`https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(String(info.songmid))}`, { headers: { ...browserHeaders, Referer: 'https://www.kuwo.cn/' } })
    lyric = Array.isArray(data?.data?.lrclist) ? data.data.lrclist.map((line: any) => `[${formatInterval(Number(line.time || 0))}]${line.lineLyric || ''}`).join('\n') : ''
  } else if (source === 'mg') {
    const target = info.lrcUrl || info.mrcUrl || info.trcUrl
    if (target) lyric = String(await fetchJson(/^https?:/.test(target) ? target : `https://d.musicapp.migu.cn${target}`))
  } else {
    const hash = encodeURIComponent(String(info.hash || info.songmid || ''))
    const candidates = await fetchJson(`https://krcs.kugou.com/search?ver=1&man=yes&client=pc&hash=${hash}`, { headers: browserHeaders })
    const candidate = Array.isArray(candidates?.candidates) ? candidates.candidates[0] : null
    if (candidate) {
      const data = await fetchJson(`https://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(candidate.id)}&accesskey=${encodeURIComponent(candidate.accesskey)}&fmt=lrc&charset=utf8`, { headers: browserHeaders })
      if (typeof data?.content === 'string') lyric = decodeURIComponent(escape(atob(data.content)))
    }
  }
  if (!lyric.trim()) throw new HttpError(404, '这首歌曲暂时没有歌词', 'lyrics_unavailable')
  return json(request, env, { lyric, translation }, 200, { 'Cache-Control': 'public, max-age=3600' })
}

export const musicStatus = async (request: Request, env: WorkerEnv, suppliedConfig?: SystemConfig) => {
  const config = suppliedConfig ?? await readSystemConfig(env)
  const credentials = await readRuntimeCredentials(env)
  const enabled = new Set(config.music.enabledProviders)
  const resolverLimited = enabled.has('tx') && !credentials.musicResolverKey
  const status = enabled.size === 0 ? 'unavailable' : resolverLimited ? 'degraded' : 'available'
  return json(request, env, {
    status,
    message: status === 'available' ? '' : resolverLimited ? '部分平台播放能力受限' : '暂无可用的音乐平台',
    providers: config.music.preferredSourceOrder.map((source) => ({
      source,
      name: providerNames[source],
      enabled: enabled.has(source),
      availability: !enabled.has(source)
        ? 'disabled'
        : source === 'mg' || source === 'tx' && resolverLimited ? 'limited' : 'enabled',
    })),
    qualities: ['128k', '320k', 'flac', 'flac24bit'],
  })
}

export const handleMusicRequest = async (request: Request, env: WorkerEnv, execution?: ExecutionContext) => {
  const url = new URL(request.url)
  const config = await readSystemConfig(env)
  if (request.method === 'GET' && url.pathname === '/v1/music/status') return musicStatus(request, env, config)
  if (request.method === 'POST' && url.pathname === '/v1/music/playback-events') return ingestMusicPlaybackHealth(request, env, execution)
  if (request.method === 'GET' && url.pathname === '/v1/music/search') return searchRequest(request, env, config, execution)
  if (request.method === 'GET' && url.pathname === '/v1/music/charts') return chartCatalogRequest(request, env, config)
  const chartMatch = url.pathname.match(/^\/v1\/music\/charts\/(tx|wy|kw|kg|mg)\/(\d+)$/)
  if (request.method === 'GET' && chartMatch) return chartDetailRequest(request, env, chartMatch[1] as Source, chartMatch[2], config, execution)
  if (request.method === 'POST' && url.pathname === '/v1/music/lyrics') return lyricRequest(request, env, config)
  if (request.method === 'POST' && url.pathname === '/v1/music/resolve') return resolveRequest(request, env, config, execution)
  throw new HttpError(404, '音乐接口不存在', 'music_route_not_found')
}
