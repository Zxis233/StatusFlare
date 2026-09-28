// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import type { DailyStat } from '../shared/models'
import type { Env } from './env'
import { db, now } from './core'

export type Sample = [offset: number, latency: number, up: number]
export type Totals = [up: number, down: number, latency: number, samples: number]
export type SampleBlock = Record<string, Sample[]>
export type DailyBlock = Record<string, Totals>

// Fetch only the requested monitor from bounded time blocks, not the entire site's history.
export async function compactHistory(env: Env, id: string) {
  const database = db(env),
    t = now(),
    path = `$."${id}"`
  const [hours, days] = await Promise.all([
    database
      .prepare(
        'SELECT hour,json_extract(samples,?) AS value FROM free_history WHERE hour>=? ORDER BY hour'
      )
      .bind(path, Math.floor((t - 12 * 3600) / 3600) * 3600)
      .all<{ hour: number; value: string | null }>(),
    database
      .prepare(
        'SELECT day,json_extract(totals,?) AS value FROM free_daily WHERE day>=? ORDER BY day'
      )
      .bind(path, Math.floor(t / 86400) * 86400 - 89 * 86400)
      .all<{ day: number; value: string | null }>(),
  ])
  return {
    samples: hours.results
      .flatMap((row) =>
        row.value
          ? (JSON.parse(row.value) as Sample[]).map(([offset, latency, up]) => ({
              checked_at: row.hour + offset,
              latency,
              up,
            }))
          : []
      )
      .filter((s) => s.checked_at >= t - 12 * 3600),
    daily: days.results.flatMap((row) => {
      if (!row.value) return []
      const [up_seconds, down_seconds, latency_sum, samples] = JSON.parse(row.value) as Totals
      return [{ monitor_id: id, day: row.day, up_seconds, down_seconds, latency_sum, samples }]
    }),
  }
}

export function mergeDaily(rows: DailyStat[]) {
  const days = new Map<number, DailyStat>()
  for (const row of rows) {
    const previous = days.get(row.day)
    if (!previous) days.set(row.day, { ...row })
    else
      for (const key of ['up_seconds', 'down_seconds', 'latency_sum', 'samples'] as const)
        previous[key] += row[key]
  }
  return [...days.values()].sort((a, b) => a.day - b.day)
}
