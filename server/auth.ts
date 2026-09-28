// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Env } from './env'
import { HttpError } from './core'
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
async function equal(a: string, b: string) {
  const hash = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  const [x, y] = await Promise.all([hash(a), hash(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}
export async function authorize(request: Request, env: Env): Promise<string> {
  const url = new URL(request.url)
  const origin = request.headers.get('origin')
  if (
    !['GET', 'HEAD'].includes(request.method) &&
    origin &&
    origin !== url.origin &&
    !(env.ENVIRONMENT === 'development' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))
  )
    throw new HttpError(403, '跨站写入已拒绝')
  const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '')
  if (bearer && env.ADMIN_API_TOKEN && (await equal(bearer, env.ADMIN_API_TOKEN)))
    return 'api-token'
  if (
    bearer &&
    env.ENVIRONMENT === 'development' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    env.DEV_ADMIN_TOKEN &&
    (await equal(bearer, env.DEV_ADMIN_TOKEN))
  )
    return 'local-developer'
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ADMIN_EMAILS)
    throw new HttpError(503, '后台认证未配置。请设置 Cloudflare Access 和管理员名单。')
  const token = request.headers.get('cf-access-jwt-assertion')
  if (!token) throw new HttpError(401, '请先通过 Cloudflare Access 登录')
  const domain = env.ACCESS_TEAM_DOMAIN.replace(/^https:\/\//, '').replace(/\/$/, '')
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain))
    throw new HttpError(503, 'Access 域名配置无效')
  const issuer = `https://${domain}`
  if (!jwks.has(issuer))
    jwks.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)))
  try {
    const { payload } = await jwtVerify(token, jwks.get(issuer)!, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
    })
    const email = String(payload.email || '').toLowerCase()
    if (
      !env.ADMIN_EMAILS.split(',')
        .map((x) => x.trim().toLowerCase())
        .includes(email)
    )
      throw new Error('Not allowed')
    return email
  } catch {
    throw new HttpError(403, 'Access 身份无效或没有管理权限')
  }
}
