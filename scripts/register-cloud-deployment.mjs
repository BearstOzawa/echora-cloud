import { createHmac } from 'node:crypto'

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

const cloudUrl = required('ECHORA_CLOUD_URL').replace(/\/$/, '')
const secret = required('ECHORA_CLOUD_INGESTION_SECRET')
const body = JSON.stringify({
  product: required('ECHORA_PRODUCT'),
  environment: process.env.ECHORA_ENVIRONMENT?.trim() || 'production',
  version: required('ECHORA_VERSION'),
  buildId: required('ECHORA_BUILD_ID'),
  commit: process.env.ECHORA_COMMIT?.trim() || undefined,
  url: process.env.ECHORA_DEPLOYMENT_URL?.trim() || undefined,
  status: process.env.ECHORA_DEPLOYMENT_STATUS?.trim() || 'healthy',
  deployedAt: Date.now(),
})
const timestamp = String(Date.now())
const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')

const response = await fetch(`${cloudUrl}/v1/internal/deployments`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Echora-Timestamp': timestamp,
    'X-Echora-Signature': `sha256=${signature}`,
  },
  body,
})

if (!response.ok) {
  const detail = (await response.text()).slice(0, 500)
  throw new Error(`Deployment registration failed with ${response.status}: ${detail}`)
}

const result = await response.json()
console.log(`Registered deployment ${result.id || '(unknown)'}.`)
