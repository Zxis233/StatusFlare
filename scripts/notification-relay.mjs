import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { ProxyAgent, fetch as proxyFetch } from 'undici'
import { z } from 'zod'

const relayRequest = z
  .object({
    url: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value)
        return url.protocol === 'https:' && !url.username && !url.password
      }),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH']),
    headers: z.record(z.string()),
    body: z.string().optional(),
    timeout: z.number().int().min(1000).max(15000),
  })
  .strict()

async function errorDetail(response) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = 16384 - size
      chunks.push(Buffer.from(value.subarray(0, remaining)))
      size += Math.min(remaining, value.length)
      if (size >= 16384) {
        truncated = true
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return (
    Buffer.concat(chunks).toString('utf8') +
    (truncated ? '\n[响应正文达到 16 KiB 上限，已截断]' : '')
  )
}

export async function startNotificationRelay(proxyUrl) {
  const proxy = new URL(proxyUrl)
  if (!['http:', 'https:'].includes(proxy.protocol))
    throw new Error('通知代理须为 HTTP 或 HTTPS 代理地址')
  const dispatcher = new ProxyAgent({
    uri: proxy.href,
    requestTls: { rejectUnauthorized: true },
    proxyTls: { rejectUnauthorized: true },
  })
  const token = randomBytes(32).toString('hex')
  const authorization = Buffer.from(`Bearer ${token}`)
  const server = createServer(async (request, response) => {
    const reply = (status, body) => {
      if (response.destroyed) return
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      response.end(JSON.stringify(body))
    }
    const provided = Buffer.from(request.headers.authorization || '')
    if (
      request.headers.origin ||
      provided.length !== authorization.length ||
      !timingSafeEqual(provided, authorization)
    ) {
      reply(403, { error: '本地通知转发认证失败' })
      return
    }
    if (request.method !== 'POST' || request.url !== '/send') {
      reply(404, { error: 'Not found' })
      return
    }
    const controller = new AbortController()
    response.on('close', () => controller.abort())
    try {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 2 * 1024 * 1024) {
          reply(413, { error: '本地通知请求过大' })
          return
        }
        chunks.push(chunk)
      }
      let input
      try {
        input = relayRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reply(400, { error: '本地通知转发参数无效' })
        return
      }
      const headers = new Headers(input.headers)
      // Transport authentication belongs only to the local hop, never the provider.
      for (const key of [
        'host',
        'content-length',
        'connection',
        'transfer-encoding',
        'proxy-authorization',
      ])
        headers.delete(key)
      const upstream = await proxyFetch(input.url, {
        method: input.method,
        headers,
        body: input.body,
        dispatcher,
        redirect: 'manual',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(input.timeout)]),
      })
      const detail = upstream.ok ? '' : await errorDetail(upstream)
      if (upstream.ok) await upstream.body?.cancel()
      reply(200, { status: upstream.status, detail })
    } catch (error) {
      const code = String(error?.cause?.code || error?.code || '')
      const timeout =
        ['TimeoutError', 'AbortError'].includes(error?.name) || code.includes('TIMEOUT')
      // Never log provider URLs, channel credentials, payloads or raw exceptions.
      reply(timeout ? 504 : 502, {
        error: timeout
          ? '本地代理请求超时'
          : '本地代理连接失败，请检查代理地址、代理进程和网络规则',
      })
    }
  })
  server.requestTimeout = 20000
  server.headersTimeout = 10000
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
  } catch (error) {
    await dispatcher.destroy()
    throw error
  }
  return {
    url: `http://127.0.0.1:${server.address().port}/send`,
    token,
    async close() {
      const closed = new Promise((resolve) => server.close(resolve))
      server.closeAllConnections()
      await dispatcher.destroy()
      await closed
    },
  }
}
