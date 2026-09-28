// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import type { Env } from './env'
import { db } from './core'
import { api } from './api'
export async function cachedApi(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  cache: Cache = (caches as unknown as { default: Cache }).default
) {
  const url = new URL(request.url)
  const allowed =
    /^\/api\/(status|data|badge|incidents(?:\/[a-zA-Z0-9_-]+\/updates)?|monitors\/[a-zA-Z0-9_-]+\/history)$/.test(
      url.pathname
    )
  if (request.method !== 'GET' || !allowed) return api(request, env)
  // Read a single small revision row. A public→private edit invalidates every POP immediately.
  const revision =
    (await db(env)
      .prepare("SELECT value FROM settings WHERE key='public_revision'")
      .first<string>('value')) || '0'
  url.searchParams.set('__revision', revision)
  const cacheKey = new Request(url.toString(), { method: 'GET' }),
    hit = await cache.match(cacheKey)
  if (hit) {
    const response = new Response(hit.body, hit)
    response.headers.set('cache-control', 'no-store')
    return response
  }
  const response = await api(request, env)
  if (response.status === 200) {
    const stored = response.clone()
    stored.headers.set('cache-control', 'public, max-age=30')
    ctx.waitUntil(cache.put(cacheKey, stored))
  }
  return response
}
