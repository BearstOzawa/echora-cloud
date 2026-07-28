import type { WorkerEnv } from './types'

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'request_failed', readonly detail?: Record<string, unknown>) {
    super(message)
  }
}

const allowedOrigin = (request: Request, env: WorkerEnv) => {
  const configured = (env.ALLOWED_ORIGIN || '*').split(',').map((value) => value.trim()).filter(Boolean)
  if (configured.includes('*')) return '*'
  const origin = request.headers.get('Origin')
  return origin && configured.includes(origin) ? origin : configured[0] || 'null'
}

export const corsHeaders = (request: Request, env: WorkerEnv) => ({
  'Access-Control-Allow-Origin': allowedOrigin(request, env),
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Echora-Device, X-Echora-Device-Name, X-Echora-Timestamp, X-Echora-Signature',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
})

export const json = (request: Request, env: WorkerEnv, body: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    ...corsHeaders(request, env),
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  },
})

export const empty = (request: Request, env: WorkerEnv, status = 204, headers: HeadersInit = {}) => new Response(null, {
  status,
  headers: { ...corsHeaders(request, env), ...headers },
})

export const readJson = async <T>(request: Request, maximumBytes = 512 * 1024): Promise<T> => {
  const declared = Number(request.headers.get('Content-Length') || 0)
  if (declared > maximumBytes) throw new HttpError(413, '请求内容过大', 'payload_too_large')
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > maximumBytes) throw new HttpError(413, '请求内容过大', 'payload_too_large')
  try {
    return JSON.parse(text || '{}') as T
  } catch {
    throw new HttpError(400, '请求内容不是有效的 JSON', 'invalid_json')
  }
}

export const errorResponse = (request: Request, env: WorkerEnv, error: unknown) => {
  if (error instanceof HttpError) return json(request, env, { error: error.code, message: error.message, ...error.detail }, error.status)
  console.error(error)
  return json(request, env, { error: 'internal_error', message: '服务暂时不可用' }, 500)
}
