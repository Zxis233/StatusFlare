import type { Env } from './env'

// Defined only by scripts/dev-worker.mjs. Production builds have no relay capability.
declare const __STATUSFLARE_LOCAL_NOTIFICATION_RELAY__: { url: string; token: string } | undefined

export async function notificationFetch(
  url: URL,
  init: RequestInit,
  timeout: number,
  env?: Env
): Promise<Response> {
  if (
    env?.ENVIRONMENT !== 'development' ||
    typeof __STATUSFLARE_LOCAL_NOTIFICATION_RELAY__ === 'undefined'
  )
    return fetch(url, init)
  const relay = __STATUSFLARE_LOCAL_NOTIFICATION_RELAY__
  if (!relay) return fetch(url, init)
  const local = new URL(relay.url)
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.pathname !== '/send')
    throw new Error('本地通知转发地址无效')
  let response: Response
  try {
    response = await fetch(local, {
      method: 'POST',
      headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        url: url.href,
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        body: init.body,
        timeout,
      }),
      redirect: 'manual',
      signal: init.signal,
    })
  } catch {
    throw new Error('本地通知转发连接失败或超时，请检查代理并重启 npm run preview')
  }
  const result = (await response.json()) as { status?: number; detail?: string; error?: string }
  if (!response.ok) throw new Error(result.error || '本地通知转发失败')
  const status = result.status!
  return new Response([204, 205, 304].includes(status) ? null : result.detail || '', { status })
}
