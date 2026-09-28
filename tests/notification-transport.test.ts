import { afterEach, expect, it, vi } from 'vitest'
import { sendWebhook } from '../server/notifications'
import { channelConfigSchema } from '../server/validation'
import type { Env } from '../server/env'

const relay = { url: 'http://127.0.0.1:12345/send', token: 'ephemeral-test-token' }
afterEach(() => vi.unstubAllGlobals())

it('relays rendered notifications in development and preserves provider headers and errors', async () => {
  vi.stubGlobal('__STATUSFLARE_LOCAL_NOTIFICATION_RELAY__', relay)
  const fetcher = vi.fn(async () => Response.json({ status: 429, detail: 'Rate limited' }))
  vi.stubGlobal('fetch', fetcher)
  const config = channelConfigSchema.parse({
    url: 'https://example.com/webhook',
    headers: { Authorization: 'Bearer provider-secret' },
    payload: { text: '$MSG' },
  })
  await expect(
    sendWebhook(config, '测试消息', { ENVIRONMENT: 'development' } as Env)
  ).rejects.toMatchObject({ status: 429, detail: 'Rate limited' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit]
  expect(url.href).toBe(relay.url)
  expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${relay.token}`)
  expect(JSON.parse(init.body as string)).toMatchObject({
    url: config.url,
    method: 'POST',
    headers: { authorization: 'Bearer provider-secret', 'content-type': 'application/json' },
    body: '{"text":"测试消息"}',
    timeout: 10000,
  })
})
it('keeps production direct even if a local relay definition exists', async () => {
  vi.stubGlobal('__STATUSFLARE_LOCAL_NOTIFICATION_RELAY__', relay)
  const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetcher)
  const config = channelConfigSchema.parse({ url: 'https://example.com/webhook' })
  await expect(sendWebhook(config, 'message', { ENVIRONMENT: 'production' } as Env)).resolves.toBe(
    204
  )
  const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit]
  expect(url.href).toBe(config.url)
  expect(new Headers(init.headers).get('authorization')).toBeNull()
})
it('does not fall back to direct sending when the relay fails', async () => {
  vi.stubGlobal('__STATUSFLARE_LOCAL_NOTIFICATION_RELAY__', relay)
  const fetcher = vi.fn(async () => {
    throw new Error('Connection lost')
  })
  vi.stubGlobal('fetch', fetcher)
  await expect(
    sendWebhook(channelConfigSchema.parse({ url: 'https://example.com/webhook' }), 'message', {
      ENVIRONMENT: 'development',
    } as Env)
  ).rejects.toThrow('本地通知转发连接失败或超时')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
