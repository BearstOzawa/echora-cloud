const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const base64Url = (bytes: Uint8Array) => {
  let value = ''
  bytes.forEach((byte) => { value += String.fromCharCode(byte) })
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export const fromBase64Url = (value: string) => {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

export const randomToken = (bytes = 32) => base64Url(crypto.getRandomValues(new Uint8Array(bytes)))

export const sha256 = async (value: string) => base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))

export const passwordHash = async (password: string, salt: string, iterations: number) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64Url(salt), iterations }, key, 256)
  return base64Url(new Uint8Array(bits))
}

export const createPasswordRecord = async (password: string, iterations: number) => {
  const salt = randomToken(16)
  return { hash: await passwordHash(password, salt, iterations), salt, iterations }
}

export const timingSafeEqual = (left: string, right: string) => {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) difference |= (a[index % a.length] ?? 0) ^ (b[index % b.length] ?? 0)
  return difference === 0
}

const encryptionKey = async (encodedKey: string) => {
  const bytes = fromBase64Url(encodedKey)
  if (bytes.byteLength !== 32) throw new Error('DATA_ENCRYPTION_KEY 必须是 32 字节的 Base64URL 值')
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export const encryptJson = async (value: unknown, encodedKey: string) => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(encodedKey), encoder.encode(JSON.stringify(value)))
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), iv: base64Url(iv), keyVersion: 1 }
}

export const decryptJson = async <T>(ciphertext: string, iv: string, encodedKey: string) => {
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(iv) }, await encryptionKey(encodedKey), fromBase64Url(ciphertext))
  return JSON.parse(decoder.decode(plaintext)) as T
}
