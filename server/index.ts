// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { DurableObject } from 'cloudflare:workers'
import { ZodError } from 'zod'
import type { Env } from './env'
import type { ProbeConfig } from '../shared/models'
import { HttpError, json } from './core'
import { schedule } from './scheduler'
import { probe } from './probe'
import { invocationEnv } from './limits'
import { cachedApi } from './cache'
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const scope = invocationEnv(env)
    env = scope.env
    const path = new URL(request.url).pathname
    try {
      if (path.startsWith('/api/') || path.startsWith('/attachments/'))
        return await cachedApi(request, env, ctx)
      const response = await env.ASSETS.fetch(request)
      const result = new Response(response.body, response)
      result.headers.set('X-Content-Type-Options', 'nosniff')
      result.headers.set('Referrer-Policy', 'same-origin')
      result.headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      )
      return result
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status)
      if (e instanceof ZodError)
        return json(
          { error: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
          400
        )
      if (String(e).includes('history import in progress'))
        return json({ error: '历史导入进行中，请等待完成或重新运行导入工具' }, 409)
      if (String(e).includes('FOREIGN KEY constraint'))
        return json({ error: '关联记录不存在，或仍有数据引用此记录' }, 409)
      if (String(e).includes('UNIQUE constraint'))
        return json({ error: '记录已存在，请刷新后重试' }, 409)
      if (String(e).includes('CHECK constraint failed'))
        return json(
          { error: '容量或并发校验未通过，请降低总检测频率、减少关联项，或刷新后重试' },
          409
        )
      console.error('Request failed', { path, type: e instanceof Error ? e.name : 'unknown' })
      return json({ error: '服务暂时不可用，请检查数据库迁移与 Worker 配置' }, 500)
    } finally {
      await scope.finish()
    }
  },
  async scheduled(event: ScheduledController, env: Env) {
    const scope = invocationEnv(env)
    try {
      await schedule(scope.env, Math.floor(event.scheduledTime / 1000))
    } finally {
      await scope.finish()
    }
  },
} satisfies ExportedHandler<Env>
export class RemoteChecker extends DurableObject<Env> {
  async check(config: ProbeConfig) {
    return probe(config)
  }
}
