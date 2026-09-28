// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { connect } from 'cloudflare:sockets'
import type { ProbeConfig } from '../shared/models'
import { assertPublicTarget } from './core'
export interface ProbeResult {
  up: boolean
  latency: number
  reason: string
  location: string
}
export async function probe(config: ProbeConfig, maximumBodyBytes = 65536): Promise<ProbeResult> {
  const start = Date.now(),
    controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeout)
  let socket: ReturnType<typeof connect> | undefined
  try {
    const target = assertPublicTarget(config.target, config.method === 'TCP_PING')
    if (config.method === 'TCP_PING') {
      socket = connect({
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: Number(target.port),
      })
      await Promise.race([
        socket.opened,
        new Promise((_, reject) =>
          controller.signal.addEventListener('abort', () => reject(new Error('timeout')), {
            once: true,
          })
        ),
      ])
      return { up: true, latency: Date.now() - start, reason: '', location: 'Cloudflare' }
    }
    const headers = new Headers(config.headers)
    if (!headers.has('User-Agent')) headers.set('User-Agent', 'StatusFlare/2.0')
    // Never forward authorization headers or request bodies to an arbitrary redirect target.
    const response = await fetch(target, {
      method: config.method,
      headers,
      body: config.body || undefined,
      redirect: 'manual',
      signal: controller.signal,
      cf: { cacheTtlByStatus: { '100-599': -1 } },
    })
    let reason = ''
    if (
      config.expectedCodes.length ? !config.expectedCodes.includes(response.status) : !response.ok
    )
      reason = `HTTP ${response.status}`
    if (!reason && (config.responseKeyword || config.responseForbiddenKeyword)) {
      const reader = response.body?.getReader()
      let size = 0,
        text = ''
      const decoder = new TextDecoder()
      if (reader)
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.length
            if (size > maximumBodyBytes) throw new Error('body_limit')
            text += decoder.decode(chunk.value, { stream: true })
          }
          text += decoder.decode()
        } finally {
          await reader.cancel().catch(() => {})
        }
      if (config.responseKeyword && !text.includes(config.responseKeyword))
        reason = '未找到预期关键词'
      if (config.responseForbiddenKeyword && text.includes(config.responseForbiddenKeyword))
        reason = '检测到禁止的关键词'
    } else {
      await response.body?.cancel()
    }
    return { up: !reason, latency: Date.now() - start, reason, location: 'Cloudflare' }
  } catch (e) {
    // Do not persist URLs, response bodies, headers or platform errors containing credentials.
    return {
      up: false,
      latency: Date.now() - start,
      reason: controller.signal.aborted
        ? `请求超时 (${config.timeout}ms)`
        : (e as Error).message === 'body_limit'
        ? `响应正文超过 ${maximumBodyBytes / 1024} KiB 检测上限`
        : '连接或响应读取失败',
      location: 'Cloudflare',
    }
  } finally {
    clearTimeout(timer)
    if (socket) await socket.close().catch(() => {})
  }
}
