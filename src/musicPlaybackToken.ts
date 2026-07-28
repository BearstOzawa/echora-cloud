import { base64Url, fromBase64Url, randomToken, sha256 } from './crypto'
import { HttpError } from './http'
import type { MusicProviderId } from './systemConfig'
import type { WorkerEnv } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const tokenLifetimeSeconds = 30 * 60
const qualityValues = new Set(['128k', '320k', 'flac', 'flac24bit'])

type PlaybackTokenPayload = {
  v: 1
  providerId: MusicProviderId
  requestedQuality: string
  resolvedQuality: string
  device: string
  issuedAt: number
  expiresAt: number
  nonce: string
}

const signingKey = async (encodedKey: string) => {
  const bytes = fromBase64Url(encodedKey)
  if (bytes.byteLength !== 32) throw new Error('DATA_ENCRYPTION_KEY 必须是 32 字节的 Base64URL 值')
  const material = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: encoder.encode('echora-cloud'),
    info: encoder.encode('music-playback-health-v1'),
  }, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify'])
}

const signedValue = (payload: string) => `echora-playback-health-v1.${payload}`
const validDeviceId = (value: string) => /^[A-Za-z0-9._:-]{1,96}$/.test(value)
const deviceDigest = async (deviceId: string) => (await sha256(deviceId)).slice(0, 24)

export const issueMusicPlaybackToken = async (
  request: Request,
  env: WorkerEnv,
  values: Pick<PlaybackTokenPayload, 'providerId' | 'requestedQuality' | 'resolvedQuality'>,
) => {
  const deviceId = request.headers.get('X-Echora-Device') || ''
  if (!env.DATA_ENCRYPTION_KEY || !validDeviceId(deviceId)) return undefined
  const now = Math.floor(Date.now() / 1000)
  const payload: PlaybackTokenPayload = {
    v: 1,
    ...values,
    device: await deviceDigest(deviceId),
    issuedAt: now,
    expiresAt: now + tokenLifetimeSeconds,
    nonce: randomToken(12),
  }
  const encoded = base64Url(encoder.encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env.DATA_ENCRYPTION_KEY), encoder.encode(signedValue(encoded)))
  return `${encoded}.${base64Url(new Uint8Array(signature))}`
}

export const verifyMusicPlaybackToken = async (request: Request, env: WorkerEnv, token: unknown) => {
  const deviceId = request.headers.get('X-Echora-Device') || ''
  if (!env.DATA_ENCRYPTION_KEY || !validDeviceId(deviceId) || typeof token !== 'string' || token.length > 768) {
    throw new HttpError(403, '播放状态凭证无效', 'invalid_playback_token')
  }
  const [encoded, signature, extra] = token.split('.')
  if (!encoded || !signature || extra) throw new HttpError(403, '播放状态凭证无效', 'invalid_playback_token')
  let payload: PlaybackTokenPayload
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await signingKey(env.DATA_ENCRYPTION_KEY),
      fromBase64Url(signature),
      encoder.encode(signedValue(encoded)),
    )
    if (!valid) throw new Error('invalid signature')
    const decoded = JSON.parse(decoder.decode(fromBase64Url(encoded))) as unknown
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid payload')
    payload = decoded as PlaybackTokenPayload
  } catch {
    throw new HttpError(403, '播放状态凭证无效', 'invalid_playback_token')
  }
  const now = Math.floor(Date.now() / 1000)
  if (
    payload.v !== 1
    || !['tx', 'wy', 'kw', 'kg', 'mg'].includes(payload.providerId)
    || !qualityValues.has(payload.requestedQuality)
    || !qualityValues.has(payload.resolvedQuality)
    || payload.device !== await deviceDigest(deviceId)
    || !Number.isInteger(payload.issuedAt)
    || !Number.isInteger(payload.expiresAt)
    || payload.issuedAt > now + 60
    || payload.expiresAt <= now
    || payload.expiresAt - payload.issuedAt !== tokenLifetimeSeconds
    || typeof payload.nonce !== 'string'
    || payload.nonce.length < 12
  ) throw new HttpError(403, '播放状态凭证无效', 'invalid_playback_token')
  return { ...payload, token }
}

export const musicPlaybackRateKey = async (deviceId: string) => `music-playback:${await deviceDigest(deviceId)}`
