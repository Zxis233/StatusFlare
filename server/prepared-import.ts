// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { z } from 'zod'
import type { Env } from './env'
import { audit, db, HttpError, now, uuid } from './core'
import { POLICY } from '../shared/policy'
const timestamp = z.number().int().nonnegative()
const row = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('daily'),
    day: timestamp,
    up: z.number().int().min(0).max(86400),
    down: z.number().int().min(0).max(86400),
    latency: z.number().nonnegative(),
    samples: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal('outage'), start: timestamp, end: timestamp }),
  z.object({
    kind: z.literal('result'),
    time: timestamp,
    up: z.union([z.literal(0), z.literal(1)]),
    ping: z.number().int().nonnegative(),
    loc: z.string().max(100),
  }),
])
const schema = z.object({
  format: z.literal('prepared-v1'),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  total: z.number().int().min(0).max(100000),
  offset: z.number().int().min(0),
  rows: z.array(row).max(100),
})
export async function importPrepared(env: Env, monitorId: string, input: unknown, actor: string) {
  const v = schema.parse(input),
    database = db(env),
    key = `history:${monitorId}`,
    token = uuid(),
    limit = POLICY.importRows
  if (
    v.rows.length > limit ||
    v.offset + v.rows.length > v.total ||
    (!v.rows.length && v.total !== 0)
  )
    throw new HttpError(400, `每批最多 ${limit} 条历史记录，批次范围必须有效`)
  for (const r of v.rows) {
    if (
      (r.kind === 'daily' && (r.up + r.down > 86400 || r.day % 86400 !== 0)) ||
      (r.kind === 'outage' && r.end < r.start)
    )
      throw new HttpError(400, '历史统计区间无效')
  }
  if (await database.prepare('SELECT id FROM import_runs WHERE id=?').bind(key).first())
    return { imported: false, continue: false, nextOffset: v.total }
  const monitor = await database
    .prepare('SELECT enabled FROM monitors WHERE id=?')
    .bind(monitorId)
    .first<{ enabled: number }>()
  if (!monitor) throw new HttpError(404, '请先导入监控配置')
  if (
    monitor.enabled ||
    (await database
      .prepare('SELECT 1 FROM current_monitor_state WHERE monitor_id=?')
      .bind(monitorId)
      .first())
  )
    throw new HttpError(409, '历史只能导入到尚未运行且已暂停的监控')
  const existing = await database
    .prepare('SELECT cursor,payload_hash FROM import_locks WHERE monitor_id=?')
    .bind(monitorId)
    .first<{ cursor: number; payload_hash: string }>()
  if (existing && existing.payload_hash !== v.digest)
    throw new HttpError(409, '请使用与开始导入时相同的历史文件')
  if (existing && v.offset < existing.cursor)
    return { imported: false, continue: true, nextOffset: existing.cursor }
  if (v.offset !== (existing?.cursor ?? 0))
    throw new HttpError(409, '批次偏移不匹配，请从已确认的进度继续')
  const claim = await database
    .prepare(
      `INSERT INTO import_locks(monitor_id,token,lease_until,payload_hash,cursor)
    SELECT id,?,?,?,0 FROM monitors WHERE id=? AND enabled=0 AND NOT EXISTS(SELECT 1 FROM current_monitor_state WHERE monitor_id=?) AND NOT EXISTS(SELECT 1 FROM import_runs WHERE id=?)
    ON CONFLICT(monitor_id) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until
    WHERE import_locks.lease_until<=? AND import_locks.payload_hash=excluded.payload_hash AND import_locks.cursor=?`
    )
    .bind(token, now() + 120, v.digest, monitorId, monitorId, key, now(), v.offset)
    .run()
  if (!claim.meta.changes) throw new HttpError(409, '导入正在进行，中断后等待两分钟重试')
  const statements: D1PreparedStatement[] = [
    database
      .prepare('UPDATE import_locks SET lease_until=? WHERE monitor_id=? AND token=? AND cursor=?')
      .bind(now() + 120, monitorId, token, v.offset),
    database.prepare('INSERT INTO result_guard(id,ok) VALUES (?,changes())').bind(token),
  ]
  statements.push(
    database
      .prepare(
        'INSERT INTO free_usage(day,imports) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET imports=imports+excluded.imports WHERE imports+excluded.imports<=5000'
      )
      .bind(Math.floor(now() / 86400), v.rows.length),
    database.prepare('UPDATE result_guard SET ok=changes() WHERE id=?').bind(token)
  )
  v.rows.forEach((r, i) => {
    if (r.kind === 'daily')
      statements.push(
        database
          .prepare(
            'INSERT INTO daily_stats VALUES (?,?,?,?,?,?) ON CONFLICT(monitor_id,day) DO UPDATE SET up_seconds=excluded.up_seconds,down_seconds=excluded.down_seconds,latency_sum=excluded.latency_sum,samples=excluded.samples'
          )
          .bind(monitorId, r.day, r.up, r.down, r.latency, r.samples)
      )
    else if (r.kind === 'outage')
      statements.push(
        database
          .prepare('INSERT OR IGNORE INTO monitor_outages VALUES (?,?,?,?,?)')
          .bind(`legacy:${monitorId}:${v.offset + i}`, monitorId, r.start, r.end, '旧版本导入')
      )
    else
      statements.push(
        database
          .prepare('INSERT OR IGNORE INTO check_results VALUES (?,?,?,?,?,?,?)')
          .bind(
            `legacy:${monitorId}:${r.time}`,
            monitorId,
            r.time,
            r.up,
            r.ping,
            '旧版本导入',
            r.loc
          )
      )
  })
  const nextOffset = v.offset + v.rows.length,
    complete = nextOffset === v.total
  if (complete)
    statements.push(
      database.prepare('INSERT OR IGNORE INTO import_runs VALUES (?,?)').bind(key, now()),
      audit(database, actor, 'history.import', monitorId),
      database
        .prepare('DELETE FROM import_locks WHERE monitor_id=? AND token=?')
        .bind(monitorId, token)
    )
  else
    statements.push(
      database
        .prepare(
          "UPDATE import_locks SET cursor=?,token='',lease_until=0 WHERE monitor_id=? AND token=?"
        )
        .bind(nextOffset, monitorId, token)
    )
  statements.push(database.prepare('DELETE FROM result_guard WHERE id=?').bind(token))
  try {
    await database.batch(statements)
  } catch (e) {
    if (String(e).includes('CHECK constraint failed')) {
      const used = await database
        .prepare('SELECT imports FROM free_usage WHERE day=?')
        .bind(Math.floor(now() / 86400))
        .first<{ imports: number }>()
      if ((used?.imports || 0) + v.rows.length > 5000) {
        await database
          .prepare("UPDATE import_locks SET token='',lease_until=0 WHERE monitor_id=? AND token=?")
          .bind(monitorId, token)
          .run()
        throw new HttpError(429, '今日历史导入预算（5000条）已用完，请在 UTC 次日用同一文件继续')
      }
    }
    throw e
  }
  return { imported: complete, continue: !complete, nextOffset }
}
