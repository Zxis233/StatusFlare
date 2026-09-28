// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import type { Env } from './env'
import { audit, db, HttpError } from './core'

export const canExportEncryptionKey = (env: Env, actor: string) =>
  env.ENABLE_KEY_EXPORT === 'true' && actor !== 'api-token'

// The caller must first authenticate the request using authorize().
export async function exportEncryptionKey(request: Request, env: Env, actor: string) {
  if (env.ENABLE_KEY_EXPORT !== 'true') throw new HttpError(404, '密钥备份下载未启用')
  if (!canExportEncryptionKey(env, actor))
    throw new HttpError(403, '请使用 Cloudflare Access 管理员身份下载密钥备份')
  if (request.method !== 'POST') throw new HttpError(405, '请从后台点击下载密钥备份')
  if (
    request.headers.get('origin') !== new URL(request.url).origin ||
    request.headers.get('x-statusflare-key-export') !== '1'
  )
    throw new HttpError(403, '请从本站后台下载密钥备份')
  if (!env.ENCRYPTION_KEY) throw new HttpError(503, '尚未配置 ENCRYPTION_KEY')
  let key: string
  try {
    const decoded = atob(env.ENCRYPTION_KEY)
    if (decoded.length !== 32) throw new Error()
    key = btoa(decoded)
  } catch {
    throw new HttpError(503, 'ENCRYPTION_KEY 配置无效')
  }
  // Record only the action and actor; never persist the key in audit data or logs.
  await audit(db(env), actor, 'encryption-key.export', 'ENCRYPTION_KEY').run()
  return new Response(`ENCRYPTION_KEY=${key}\n`, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="statusflare-encryption-key.env"',
      'cache-control': 'private, no-store, max-age=0',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    },
  })
}
