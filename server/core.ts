// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { z } from 'zod'
import type { Env } from './env'
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}
export const now = () => Math.floor(Date.now() / 1000)
export const uuid = () => crypto.randomUUID()
export const db = (env: Env) => env.STATUSFLARE_D1.withSession('first-primary')
export function invalidatePublic(database: D1DatabaseSession) {
  return database.prepare(
    "INSERT INTO settings VALUES ('public_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)"
  )
}
export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
export async function body(request: Request, maximumBytes = 1_000_000, allowEmpty = false) {
  const isJson = request.headers.get('content-type')?.includes('application/json')
  if (!allowEmpty && !isJson) throw new HttpError(415, '需要 application/json')
  const reader = request.body?.getReader()
  if (!reader) {
    if (allowEmpty) return undefined
    throw new HttpError(400, '请求体为空')
  }
  let size = 0
  const chunks: Uint8Array[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maximumBytes) {
      await reader.cancel()
      throw new HttpError(413, '请求内容过大')
    }
    chunks.push(value)
  }
  if (allowEmpty && size === 0) return undefined
  if (!isJson) throw new HttpError(415, '需要 application/json')
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.length
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new HttpError(400, 'JSON 格式错误')
  }
}
export function audit(
  database: D1DatabaseSession,
  actor: string,
  action: string,
  resource: string
) {
  return database
    .prepare('INSERT INTO audit_logs VALUES (?,?,?,?,?)')
    .bind(uuid(), actor, action, resource, now())
}
function encode(bytes: Uint8Array) {
  let value = ''
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(value)
}
function decode(text: string) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
}
let cachedKey: { value: string; key: Promise<CryptoKey> } | undefined
async function key(env: Env) {
  if (!env.ENCRYPTION_KEY) throw new HttpError(503, '尚未配置 ENCRYPTION_KEY')
  if (cachedKey?.value === env.ENCRYPTION_KEY) return cachedKey.key
  let raw: Uint8Array
  try {
    raw = decode(env.ENCRYPTION_KEY)
  } catch {
    throw new HttpError(503, 'ENCRYPTION_KEY 配置无效')
  }
  if (raw.length !== 32) throw new HttpError(503, 'ENCRYPTION_KEY 必须为 32 字节的 Base64')
  const imported = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
  cachedKey = { value: env.ENCRYPTION_KEY, key: imported }
  return imported
}
export async function seal(env: Env, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await key(env),
    new TextEncoder().encode(JSON.stringify(value))
  )
  return `v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`
}
export async function unseal<T>(env: Env, value: string): Promise<T> {
  const [version, iv, data] = value.split('.')
  if (version !== 'v1') throw new Error('Unsupported secret format')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(iv) },
    await key(env),
    decode(data)
  )
  return JSON.parse(new TextDecoder().decode(plain)) as T
}
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
export const text = (max = 200) => z.string().trim().min(1).max(max)
export function assertPublicTarget(raw: string, tcp = false) {
  let url: URL
  try {
    url = new URL(tcp ? `tcp://${raw}` : raw)
  } catch {
    throw new HttpError(400, '目标地址格式错误')
  }
  if (
    !(tcp ? url.protocol === 'tcp:' : ['http:', 'https:'].includes(url.protocol)) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw new HttpError(400, '只允许无内嵌密码的 HTTP/HTTPS 地址')
  const host = new URL(`http://${url.host}`).hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '::' ||
    host === '::1' ||
    host.startsWith('::ffff:') ||
    (/^(fc|fd|fe[89ab]|ff)/i.test(host) && host.includes(':'))
  )
    throw new HttpError(400, '不允许本地或私网目标')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number)
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
      throw new HttpError(400, '不允许私网目标')
  }
  if (
    tcp &&
    (!url.port ||
      Number(url.port) < 1 ||
      Number(url.port) > 65535 ||
      !['', '/'].includes(url.pathname) ||
      url.search ||
      url.hash)
  )
    throw new HttpError(400, 'TCP 目标应为 hostname:port')
  return url
}
