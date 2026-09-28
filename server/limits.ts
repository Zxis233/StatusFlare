// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import type { Env } from './env'
import { HttpError } from './core'

// Count SQL statements across all D1 sessions in ONE invocation, including batches.
// Reject before submitting an oversized batch, rather than partly executing it.
export function invocationEnv(env: Env) {
  let queries = 0,
    writes = 0,
    finished = false
  const original = env.STATUSFLARE_D1,
    originals = new WeakMap<object, D1PreparedStatement>()
  const reserve = (n: number) => {
    if (queries + n > 49) throw new HttpError(503, '本次操作超过查询预算，请拆分操作')
    queries += n
  }
  const record = (result: any) => {
    for (const item of Array.isArray(result) ? result : [result])
      writes += Number(item?.meta?.rows_written || 0)
    return result
  }
  const statement = (base: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(base, {
      get(target, prop) {
        if (prop === 'bind') return (...args: any[]) => statement(target.bind(...args))
        if (prop === 'first')
          return async (column?: string) => {
            reserve(1)
            const result = record(await target.all())
            const row = result.results[0]
            return row ? (column ? row[column] : row) : null
          }
        if (['all', 'run', 'raw'].includes(String(prop)))
          return async (...args: any[]) => {
            reserve(1)
            return record(await (target as any)[prop](...args))
          }
        return Reflect.get(target, prop)
      },
    })
    originals.set(wrapped, base)
    return wrapped
  }
  const database = new Proxy(original, {
    get(target, prop) {
      if (prop === 'withSession')
        return (...args: any[]) => {
          const session = target.withSession(...args)
          return new Proxy(session, {
            get(s, p) {
              if (p === 'prepare') return (sql: string) => statement(s.prepare(sql))
              if (p === 'batch')
                return async (items: D1PreparedStatement[]) => {
                  reserve(items.length)
                  return record(await s.batch(items.map((i) => originals.get(i) || i)))
                }
              const v = Reflect.get(s, p)
              return typeof v === 'function' ? v.bind(s) : v
            },
          })
        }
      const v = Reflect.get(target, prop)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  return {
    env: { ...env, STATUSFLARE_D1: database },
    queryCount: () => queries,
    writes: () => writes,
    async finish() {
      if (finished) return
      finished = true
      if (writes > 0) {
        queries++
        await original
          .withSession('first-primary')
          .prepare(
            'INSERT INTO free_usage(day,writes) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET writes=writes+excluded.writes'
          )
          .bind(Math.floor(Date.now() / 1000 / 86400), writes + 1)
          .run()
      }
    },
  }
}
