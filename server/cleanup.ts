// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import type { Env } from './env'
import { db, now, uuid } from './core'

export async function cleanup(env: Env, slot = Math.floor(now() / 60)) {
  const database = db(env),
    t = now(),
    day = Math.floor(t / 86400)
  const lease = await database
    .prepare(
      `INSERT INTO free_usage(day,cleanup_slot) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET cleanup_slot=excluded.cleanup_slot WHERE cleanup_slot<excluded.cleanup_slot RETURNING day`
    )
    .bind(day, slot)
    .first()
  if (!lease) return
  // Bound each five-minute pass to keep retention work within the write budget.
  const old = await database
    .prepare('SELECT * FROM check_results WHERE checked_at<? ORDER BY checked_at,id LIMIT 5')
    .bind(t - 7 * 86400)
    .all<{ id: string }>()
  if (old.results.length) {
    if (env.STORAGE)
      await env.STORAGE.put(`history/${day}/${uuid()}.json`, JSON.stringify(old.results), {
        httpMetadata: { contentType: 'application/json' },
      })
    await database
      .prepare(`DELETE FROM check_results WHERE id IN (${old.results.map(() => '?').join(',')})`)
      .bind(...old.results.map((r) => r.id))
      .run()
  }
  const cutoff = Math.floor((t - 7 * 86400) / 3600) * 3600
  const blocks = await database
    .prepare('SELECT hour,samples FROM free_history WHERE hour<? ORDER BY hour LIMIT 2')
    .bind(cutoff)
    .all<{ hour: number; samples: string }>()
  if (blocks.results.length && env.STORAGE)
    await env.STORAGE.put(
      `history/compact/${blocks.results[0].hour}.json`,
      JSON.stringify(blocks.results),
      {
        httpMetadata: { contentType: 'application/json' },
      }
    )
  await database.batch([
    database
      .prepare(
        'DELETE FROM free_history WHERE hour IN (SELECT hour FROM free_history WHERE hour<? ORDER BY hour LIMIT 2)'
      )
      .bind(cutoff),
    database
      .prepare(
        'DELETE FROM free_daily WHERE day IN (SELECT day FROM free_daily WHERE day<? LIMIT 2)'
      )
      .bind(t - 366 * 86400),
    database
      .prepare(
        'DELETE FROM daily_stats WHERE rowid IN (SELECT rowid FROM daily_stats WHERE day<? LIMIT 2)'
      )
      .bind(t - 366 * 86400),
    database
      .prepare(
        'DELETE FROM monitor_outages WHERE id IN (SELECT id FROM monitor_outages WHERE end_at IS NOT NULL AND end_at<? LIMIT 3)'
      )
      .bind(t - 90 * 86400),
    database
      .prepare(
        "DELETE FROM notification_outbox WHERE id IN (SELECT id FROM notification_outbox WHERE state IN ('sent','cancelled','failed') AND created_at<? LIMIT 10)"
      )
      .bind(t - 30 * 86400),
    database
      .prepare(
        'DELETE FROM free_usage WHERE day IN (SELECT day FROM free_usage WHERE day<? LIMIT 1)'
      )
      .bind(day - 7),
  ])
}
