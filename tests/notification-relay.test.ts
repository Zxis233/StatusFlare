import { afterEach, expect, it, vi } from 'vitest'
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn() }))
vi.mock('undici', async (original) => ({
  ...(await original<typeof import('undici')>()),
  fetch: upstream,
}))
import { startNotificationRelay } from '../scripts/notification-relay.mjs'

let relay: Awaited<ReturnType<typeof startNotificationRelay>> | undefined
afterEach(async () => {
  await relay?.close()
  relay = undefined
  upstream.mockReset()
})
const input = {
  url: 'https://example.com/hook',
  method: 'POST',
  headers: { authorization: 'Bearer provider-secret' },
  body: 'message',
  timeout: 1000,
}
async function send(value: unknown = input, authorized = true) {
  return fetch(relay!.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorized ? { authorization: `Bearer ${relay!.token}` } : {}),
    },
    body: JSON.stringify(value),
  })
}
it('requires its ephemeral token and rejects invalid forwarding requests', async () => {
  relay = await startNotificationRelay('http://127.0.0.1:7890')
  expect((await send(input, false)).status).toBe(403)
  expect((await send({ ...input, url: 'http://example.com' })).status).toBe(400)
  expect((await send({ ...input, timeout: 60000 })).status).toBe(400)
  expect(upstream).not.toHaveBeenCalled()
})
it('uses the proxy dispatcher without following redirects or leaking relay authentication', async () => {
  relay = await startNotificationRelay('http://127.0.0.1:7890')
  upstream.mockResolvedValue(
    new Response('Moved', { status: 302, headers: { location: 'https://other.example.com' } })
  )
  const response = await send()
  expect(await response.json()).toEqual({ status: 302, detail: 'Moved' })
  const [url, options] = upstream.mock.calls[0]
  expect(url).toBe(input.url)
  expect(options.dispatcher.constructor.name).toBe('ProxyAgent')
  expect(options.redirect).toBe('manual')
  expect(options.body).toBe('message')
  expect(options.headers.get('authorization')).toBe('Bearer provider-secret')
  expect(options.headers.get('authorization')).not.toContain(relay.token)
})
it('bounds error responses and gives sanitized errors for connection failures', async () => {
  relay = await startNotificationRelay('http://127.0.0.1:7890')
  upstream.mockResolvedValueOnce(new Response('x'.repeat(20000), { status: 400 }))
  const result = (await (await send()).json()) as { detail: string }
  expect(result.detail.length).toBeLessThan(17000)
  expect(result.detail).toContain('已截断')
  upstream.mockRejectedValueOnce(new Error('https://secret-provider.example/bot-credential'))
  const response = await send()
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain('bot-credential')
})
