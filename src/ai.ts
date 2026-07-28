import { authenticate } from './auth'
import { HttpError, json, readJson } from './http'
import type { WorkerEnv } from './types'
import { readSystemConfig } from './systemConfig'
import { readRuntimeCredentials } from './systemCredentials'
import type { ManagedAiProvider } from './systemCredentials'
import { readCustomAiCredential } from './sync'

const provider = (value: string): ManagedAiProvider => {
  value = value.toLocaleLowerCase()
  if (value === 'anthropic' || value === 'compatible') return value
  return 'openai'
}

const endpoint = (base: string, path: string) => {
  const normalized = base.trim().replace(/\/+$/, '')
  const suffix = path.replace(/^\/+/, '')
  return normalized.toLocaleLowerCase().endsWith(`/${suffix.toLocaleLowerCase()}`) ? normalized : `${normalized}/${suffix}`
}

const customEndpoint = (base: string, selected: string) => endpoint(base, selected === 'openai' ? 'responses' : selected === 'anthropic' ? 'v1/messages' : 'chat/completions')

const customAiPayload = (body: unknown, model: string) => {
  let parsed = body
  if (typeof body === 'string') {
    try { parsed = JSON.parse(body) } catch { throw new HttpError(400, 'AI 请求内容不是有效的 JSON', 'invalid_ai_request') }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'AI 请求内容不完整', 'invalid_ai_request')
  return { ...parsed as Record<string, unknown>, model }
}

const customAiHeaders = (selected: string, apiKey: string) => {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (selected === 'anthropic') {
    headers.set('x-api-key', apiKey)
    headers.set('anthropic-version', '2023-06-01')
  } else if (apiKey) {
    headers.set('Authorization', `Bearer ${apiKey}`)
  }
  return headers
}

const upstreamError = (data: any, status: number) => String(data?.error?.message || data?.message || `AI 服务返回 ${status}`)

type ManagedRequest = {
  instructions?: unknown
  input?: unknown
  schema?: unknown
}

const normalizeManagedResponse = (selected: ManagedAiProvider, data: any) => {
  if (selected === 'anthropic') {
    const blocks = Array.isArray(data?.content) ? data.content : []
    return {
      content: String(blocks.find((item: any) => item?.type === 'text')?.text || ''),
      reasoning: blocks.filter((item: any) => item?.type === 'thinking').map((item: any) => item?.thinking).filter(Boolean),
    }
  }
  if (selected === 'compatible') {
    const message = data?.choices?.[0]?.message
    const content = Array.isArray(message?.content) ? message.content.map((part: any) => part?.text || '').join('') : message?.content
    return { content: String(content || ''), reasoning: [message?.reasoning_content, message?.reasoning].filter(Boolean) }
  }
  const content = typeof data?.output_text === 'string'
    ? data.output_text
    : (Array.isArray(data?.output) ? data.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : []).find((item: any) => item?.type === 'output_text')?.text : '')
  const reasoning = Array.isArray(data?.output)
    ? data.output.flatMap((item: any) => item?.type === 'reasoning' && Array.isArray(item?.summary) ? item.summary.map((summary: any) => summary?.text) : [])
    : []
  return { content: String(content || ''), reasoning: reasoning.filter(Boolean) }
}

export const managedAiRequest = async (request: Request, env: WorkerEnv) => {
  await authenticate(request, env)
  if (!(await readSystemConfig(env)).features.echoraAi) throw new HttpError(503, 'Echora AI 当前暂停服务', 'echora_ai_disabled')
  const managed = (await readRuntimeCredentials(env)).ai
  if (!managed.apiKey || !managed.baseUrl || !managed.model) throw new HttpError(503, 'Echora AI 尚未完成配置', 'echora_ai_unavailable')
  const body = await readJson<ManagedRequest>(request, 256 * 1024)
  const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : ''
  const input = typeof body.input === 'string' ? body.input : ''
  const schema = body.schema && typeof body.schema === 'object' ? body.schema : null
  if (!instructions || !input || !schema) throw new HttpError(400, 'AI 请求内容不完整', 'invalid_ai_request')
  const selected = provider(managed.provider)
  let url: string
  let payload: Record<string, unknown>
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (selected === 'anthropic') {
    url = endpoint(managed.baseUrl, 'v1/messages')
    headers.set('x-api-key', managed.apiKey)
    headers.set('anthropic-version', '2023-06-01')
    payload = {
      model: managed.model,
      max_tokens: 1200,
      system: `${instructions}\nJSON Schema: ${JSON.stringify(schema)}`,
      messages: [{ role: 'user', content: input }],
    }
  } else if (selected === 'compatible') {
    url = endpoint(managed.baseUrl, 'chat/completions')
    headers.set('Authorization', `Bearer ${managed.apiKey}`)
    payload = {
      model: managed.model,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: `${instructions}\nJSON Schema: ${JSON.stringify(schema)}` }, { role: 'user', content: input }],
    }
  } else {
    url = endpoint(managed.baseUrl, 'responses')
    headers.set('Authorization', `Bearer ${managed.apiKey}`)
    payload = {
      model: managed.model,
      store: false,
      instructions,
      input,
      text: { format: { type: 'json_schema', name: 'listening_plan', strict: true, schema } },
    }
  }
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(50_000) })
  const text = await response.text()
  let data: unknown
  try { data = JSON.parse(text) } catch { data = { message: text.slice(0, 500) } }
  if (!response.ok) throw new HttpError(response.status >= 500 ? 502 : 400, upstreamError(data, response.status), 'ai_upstream_error')
  return json(request, env, normalizeManagedResponse(selected, data))
}

export const customAiRequest = async (request: Request, env: WorkerEnv) => {
  if (!(await readSystemConfig(env)).features.customAi) throw new HttpError(503, '自定义 AI 当前暂停服务', 'custom_ai_disabled')
  const context = await authenticate(request, env)
  const credential = await readCustomAiCredential(env, context.user.id)
  if (!credential) throw new HttpError(409, '请先完成自定义 AI 配置', 'custom_ai_unconfigured')
  const body = await readJson<{ body?: unknown }>(request, 256 * 1024)
  const payload = customAiPayload(body.body, credential.model)
  let response: Response
  try {
    response = await fetch(customEndpoint(credential.baseUrl, credential.provider), {
      method: 'POST',
      headers: customAiHeaders(credential.provider, credential.apiKey),
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(50_000),
    })
  } catch {
    throw new HttpError(502, '无法连接自定义 AI 服务', 'custom_ai_unreachable')
  }
  const text = await response.text()
  let data: unknown
  try { data = JSON.parse(text) } catch { data = { message: text.slice(0, 500) || `AI 服务返回 ${response.status}` } }
  if (!response.ok) throw new HttpError(response.status >= 500 ? 502 : 400, upstreamError(data, response.status), 'ai_upstream_error', { upstreamStatus: response.status })
  return json(request, env, data)
}

export const aiStatus = async (request: Request, env: WorkerEnv) => {
  const config = await readSystemConfig(env)
  const managed = (await readRuntimeCredentials(env)).ai
  return json(request, env, { echoraAi: { available: config.features.echoraAi && Boolean(managed.apiKey && managed.baseUrl && managed.model) } })
}
