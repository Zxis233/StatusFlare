// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import type { Env } from './env'
import type { ChannelConfig } from './validation'
import { assertPublicTarget, db, now, unseal, uuid } from './core'
import { POLICY } from '../shared/policy'
import { notificationFetch } from './notification-transport'
export function enqueueNotification(
  database: D1DatabaseSession,
  id: string,
  message: string,
  condition = '1=1',
  args: (string | number)[] = [],
  channelLimit = POLICY.maxChannels
) {
  const t = now()
  return database
    .prepare(
      `INSERT OR IGNORE INTO notification_outbox(id,channel_id,message,available_at,created_at) SELECT ?||':'||id,id,?,?,? FROM notification_channels WHERE enabled=1 AND (${condition}) ORDER BY id LIMIT ?`
    )
    .bind(id, message, t, t, ...args, channelLimit)
}
function template(value: unknown, message: string): unknown {
  if (typeof value === 'string') return value.replaceAll('$MSG', message)
  if (Array.isArray(value)) return value.map((v) => template(v, message))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, template(v, message)]))
  return value
}
class WebhookHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string
  ) {
    super(`HTTP ${status}`)
  }
}
async function responseDetail(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const limit = 16 * 1024
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      const remaining = limit - bytes
      text += decoder.decode(value.subarray(0, remaining), { stream: true })
      bytes += value.byteLength
      if (bytes >= limit) return text + decoder.decode() + '\n[响应正文达到 16 KiB 上限，已截断]'
    }
  } catch (error) {
    return text + `\n[读取响应正文失败：${error instanceof Error ? error.message : String(error)}]`
  } finally {
    await reader.cancel().catch(() => {})
  }
}
export function notificationError(error: unknown): string {
  if (error instanceof WebhookHttpError)
    return `接收端返回 HTTP ${error.status}${error.detail ? `\n${error.detail}` : ''}`
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
    return `请求超时或已中止：${error.name}: ${error.message}`
  if (error instanceof Error)
    return `发送失败：${error.name}: ${error.message}${
      error.cause ? `\n原因：${String(error.cause)}` : ''
    }`
  return `发送失败：${String(error)}`
}
export async function sendWebhook(config: ChannelConfig, message: string, env?: Env) {
  const url = assertPublicTarget(config.url)
  if (url.protocol !== 'https:') throw new Error('HTTPS required')
  const payload = template(config.payload, message) as Record<string, unknown>
  const headers = new Headers(config.headers)
  let content: string | undefined
  if (config.payloadType === 'param')
    for (const [k, v] of Object.entries(payload)) url.searchParams.set(k, String(v))
  else if (config.payloadType === 'json') {
    headers.set('content-type', 'application/json')
    content = JSON.stringify(payload)
  } else {
    headers.set('content-type', 'application/x-www-form-urlencoded')
    content = new URLSearchParams(
      Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)]))
    ).toString()
  }
  const response = await notificationFetch(
    url,
    {
      method: config.method || (config.payloadType === 'param' ? 'GET' : 'POST'),
      headers,
      body: content,
      // Workers supports manual redirects; the non-2xx check below rejects them.
      redirect: 'manual',
      signal: AbortSignal.timeout(config.timeout),
    },
    config.timeout,
    env
  )
  if (!response.ok) throw new WebhookHttpError(response.status, await responseDetail(response))
  await response.body?.cancel()
  return response.status
}
export async function deliver(env: Env, id: string) {
  const database = db(env),
    token = uuid(),
    t = now()
  const row = await database
    .prepare(
      `UPDATE notification_outbox SET state='sending',token=?,lease_until=?,attempts=attempts+1 WHERE id=? AND state IN ('pending','sending') AND available_at<=? AND lease_until<=? RETURNING *`
    )
    .bind(token, t + 60, id, t, t)
    .first<{ channel_id: string; message: string; attempts: number }>()
  if (!row) return
  try {
    const channel = await database
      .prepare('SELECT config,enabled FROM notification_channels WHERE id=?')
      .bind(row.channel_id)
      .first<{ config: string; enabled: number }>()
    if (!channel?.enabled) {
      await database
        .prepare(
          "UPDATE notification_outbox SET state='cancelled',token=NULL WHERE id=? AND token=?"
        )
        .bind(id, token)
        .run()
      return
    }
    const config = await unseal<ChannelConfig>(env, channel.config)
    await sendWebhook(config, row.message, env)
    await database
      .prepare(
        "UPDATE notification_outbox SET state='sent',error=NULL,token=NULL,lease_until=0 WHERE id=? AND token=?"
      )
      .bind(id, token)
      .run()
  } catch {
    // Provider errors may contain a bot token or message body. Persist only a generic failure.
    await database
      .prepare(
        'UPDATE notification_outbox SET state=?,error=?,token=NULL,lease_until=0,available_at=? WHERE id=? AND token=?'
      )
      // .bind(
      //   row.attempts >= 8 ? 'failed' : 'pending',
      //   '发送失败，请检查渠道配置或接收端',
      //   t + Math.min(3600, 30 * 2 ** row.attempts),
      //   id,
      //   token
      // )
      .bind(
        row.attempts >= 5 ? 'failed' : 'pending',
        '发送失败，请检查渠道配置或接收端',
        t + 60,
        id,
        token
      )
      .run()
  }
}
