// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import type { Env } from './env'
import type { MonitorRow, ProbeConfig } from '../shared/models'
import type { ProbeResult } from './probe'
import type { DailyBlock, SampleBlock } from './compact-history'
import { db, now, unseal, uuid } from './core'
import { splitInterval } from './history'
import { deliver } from './notifications'
import { probe } from './probe'
import { POLICY } from '../shared/policy'
import { cleanup } from './cleanup'
import { loadNotificationTemplates } from './notification-templates'
import {
  renderNotificationTemplate,
  formatNotificationTime,
} from '../shared/notification-templates'

interface State {
  monitor_id: string
  status: string
  checked_at: number
  latency: number
  version: number
  failure_since: number | null
  alerted: number
  result_id: string
}
type Result = { monitor: MonitorRow; result: ProbeResult }

// One persisted lease/slot for the whole batch replaces twenty per-monitor leases.
// Never rely on isolate memory to retain history between scheduled invocations.
export async function schedule(
  env: Env,
  scheduledAt = now(),
  tester: (config: ProbeConfig) => Promise<ProbeResult> = probe
) {
  const database = db(env),
    t = now(),
    day = Math.floor(t / 86400)
  // Rate-limit delayed/replayed Cron events by the actual execution minute as well.
  const slot = Math.floor(t / 60),
    eventSlot = Math.floor(scheduledAt / 60),
    token = uuid()
  const usage = await database
    .prepare('SELECT writes,checks,check_slot FROM free_usage WHERE day=?')
    .bind(day)
    .first<{ writes: number; checks: number; check_slot: number }>()
  if ((usage?.writes || 0) >= POLICY.writeBudget) return
  if (usage && usage.check_slot >= eventSlot) return
  const claimed = await database
    .prepare(
      'UPDATE free_runtime SET token=?,lease_until=?,slot=? WHERE id=1 AND lease_until<=? AND slot<? RETURNING attempts'
    )
    .bind(token, t + 300, slot, t, slot)
    .first<{ attempts: string }>()
  if (!claimed) return
  try {
    const [monitors, states] = await Promise.all([
      database.prepare('SELECT * FROM monitors WHERE enabled=1').all<MonitorRow>(),
      database.prepare('SELECT * FROM current_monitor_state').all<State>(),
    ])
    const previous = new Map(states.results.map((s) => [s.monitor_id, s]))
    const attempts: Record<string, { version: number; at: number }> = Object.assign(
      Object.create(null),
      JSON.parse(claimed.attempts)
    )
    const dueAt = (m: MonitorRow) => {
      const s = previous.get(m.id)
      const lastAttempt = Math.max(s?.checked_at || 0, attempts[m.id]?.at || 0)
      if ((m.manual_check_at || 0) > lastAttempt)
        return Math.floor(lastAttempt / 60) * 60 + POLICY.minimumInterval
      const interval = Math.ceil(Math.max(POLICY.minimumInterval, m.interval) / 60) * 60
      return Math.max(
        m.next_check_at,
        s?.version === m.version ? Math.floor(s.checked_at / 60) * 60 + interval : 0,
        attempts[m.id]?.version === m.version
          ? Math.floor(attempts[m.id].at / 60) * 60 + interval
          : 0
      )
    }
    const due = monitors.results
      .filter((m) => dueAt(m) <= t)
      .sort((a, b) => dueAt(a) - dueAt(b) || a.id.localeCompare(b.id))
      .slice(
        0,
        Math.max(0, Math.min(POLICY.checksPerMinute, POLICY.checksPerDay - (usage?.checks || 0)))
      )
    // Reserve attempted checks before network requests. A crashed invocation still
    // consumes its reservation, so retries cannot exceed the daily limit.
    const reserved = await database
      .prepare(
        `INSERT INTO free_usage(day,checks,check_slot) VALUES (?,?,?)
       ON CONFLICT(day) DO UPDATE SET checks=checks+excluded.checks,check_slot=excluded.check_slot
       WHERE checks+excluded.checks<=? AND check_slot<excluded.check_slot RETURNING checks`
      )
      .bind(day, due.length, eventSlot, POLICY.checksPerDay)
      .first()
    if (!reserved) return
    if (due.length) {
      for (const m of due) attempts[m.id] = { version: m.version, at: t }
      const marked = await database
        .prepare('UPDATE free_runtime SET attempts=? WHERE id=1 AND token=? AND lease_until>?')
        .bind(JSON.stringify(attempts), token, now())
        .run()
      if (!marked.meta.changes) return
    }
    const results: Result[] = []
    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(5, due.length) }, async () => {
        while (cursor < due.length) {
          if (now() >= t + 300) return // A replaced/expired batch must not launch further probes.
          const monitor = due[cursor++]
          try {
            const config = await unseal<ProbeConfig>(env, monitor.config)
            let result: ProbeResult
            if (config.region && env.REMOTE_CHECKER_DO) {
              try {
                result = await env.REMOTE_CHECKER_DO.get(
                  env.REMOTE_CHECKER_DO.idFromName(`${monitor.id}:${config.region}`),
                  { locationHint: config.region as DurableObjectLocationHint }
                ).check(config)
              } catch (e) {
                if (!config.fallback) throw e
                result = await tester(config)
              }
            } else if (config.region && !config.fallback)
              throw new Error('Remote checker unavailable')
            else result = await tester(config)
            results.push({ monitor, result })
          } catch {
            // An internal/decryption failure isn't proof that the target is down.
            console.warn(`Probe failed for monitor ${monitor.id}`)
          }
        }
      })
    )
    if (results.length) await commitBatch(env, token, t, results, previous)
    const pending = await database
      .prepare(
        "SELECT id FROM notification_outbox WHERE state IN ('pending','sending') AND available_at<=? AND lease_until<=? ORDER BY available_at,created_at LIMIT 2"
      )
      .bind(t, t)
      .all<{ id: string }>()
    for (const item of pending.results) {
      const quota = await database
        .prepare(
          'INSERT INTO free_usage(day,deliveries) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET deliveries=deliveries+1 WHERE deliveries<2880 RETURNING deliveries'
        )
        .bind(day)
        .first()
      if (quota) await deliver(env, item.id)
    }
    if (slot % 5 === 0) await cleanup(env, slot)
  } finally {
    await database
      .prepare('UPDATE free_runtime SET token=NULL,lease_until=0 WHERE id=1 AND token=?')
      .bind(token)
      .run()
  }
}

async function commitBatch(
  env: Env,
  token: string,
  t: number,
  results: Result[],
  previous: Map<string, State>
) {
  const database = db(env),
    hour = Math.floor(t / 3600) * 3600,
    day = Math.floor(t / 86400) * 86400
  const [current, history, daily, maintenance, channels, templates] = await Promise.all([
    database
      .prepare('SELECT id,version FROM monitors WHERE enabled=1')
      .all<{ id: string; version: number }>(),
    database
      .prepare('SELECT samples FROM free_history WHERE hour=?')
      .bind(hour)
      .first<{ samples: string }>(),
    database
      .prepare('SELECT day,totals FROM free_daily WHERE day>=?')
      .bind(day - 2 * 86400)
      .all<{ day: number; totals: string }>(),
    database
      .prepare(
        "SELECT DISTINCT ec.component_id FROM events e JOIN event_components ec ON ec.event_id=e.id WHERE e.kind='maintenance' AND e.published=1 AND e.status IN ('scheduled','in_progress') AND e.start_at<=? AND (e.end_at IS NULL OR e.end_at>?)"
      )
      .bind(t, t)
      .all<{ component_id: string }>(),
    database
      .prepare('SELECT id FROM notification_channels WHERE enabled=1 ORDER BY id LIMIT 2')
      .all<{ id: string }>(),
    loadNotificationTemplates(database),
  ])
  const versions = new Map(current.results.map((m) => [m.id, m.version]))
  const accepted = results.filter(({ monitor }) => versions.get(monitor.id) === monitor.version)
  if (!accepted.length) return
  const state: Record<string, State> = Object.fromEntries(previous)
  const samples: SampleBlock = Object.assign(
    Object.create(null),
    history ? JSON.parse(history.samples) : {}
  )
  const days = new Map(
    daily.results.map((d) => [
      d.day,
      Object.assign(Object.create(null), JSON.parse(d.totals)) as DailyBlock,
    ])
  )
  const changedDays = new Set<number>(),
    muted = new Set(maintenance.results.map((m) => m.component_id))
  const closed: { id: string; end: number }[] = [],
    opened: { id: string; monitor: string; start: number; reason: string }[] = []
  const notifications: { id: string; channel: string; message: string }[] = []
  for (const { monitor: m, result: r } of accepted) {
    const old = previous.get(m.id),
      interval = Math.max(POLICY.minimumInterval, m.interval)
    const fresh = !!old && old.version === m.version && t - old.checked_at <= interval * 2
    const failureSince = r.up ? null : fresh && old!.status === 'down' ? old!.failure_since ?? t : t
    let alerted = fresh ? old!.alerted : 0
    const notify =
      m.notify &&
      channels.results.length &&
      !muted.has(m.component_id) &&
      ((!r.up && !alerted && t - failureSince! >= m.grace) || (r.up && !!alerted))
    alerted = r.up ? 0 : alerted || Number(!!notify)
    const resultId = `batch:${m.id}:${m.version}:${t}`
    state[m.id] = {
      monitor_id: m.id,
      status: r.up ? 'up' : 'down',
      checked_at: t,
      latency: r.latency,
      version: m.version,
      failure_since: failureSince,
      alerted,
      result_id: resultId,
    }
    ;(samples[m.id] ||= []).push([t - hour, r.latency, Number(r.up)])
    const segments =
      old && old.version === m.version
        ? splitInterval(
            old.checked_at,
            Math.min(t, old.checked_at + interval * 2),
            old.status === 'up'
          )
        : []
    let today = segments.find((s) => s.day === day)
    if (!today) {
      today = { day, up_seconds: 0, down_seconds: 0, latency_sum: 0, samples: 0 }
      segments.push(today)
    }
    today.latency_sum = r.latency
    today.samples = 1
    for (const s of segments) {
      let totals = days.get(s.day)
      if (!totals) {
        totals = Object.create(null) as DailyBlock
        days.set(s.day, totals)
      }
      const row = (totals[m.id] ||= [0, 0, 0, 0])
      row[0] += s.up_seconds
      row[1] += s.down_seconds
      row[2] += s.latency_sum
      row[3] += s.samples
      changedDays.add(s.day)
    }
    if (old && !fresh) closed.push({ id: m.id, end: Math.min(t, old.checked_at + interval * 2) })
    else if (r.up && old?.status === 'down') closed.push({ id: m.id, end: t })
    if (!r.up && (!fresh || old?.status !== 'down'))
      opened.push({ id: resultId, monitor: m.id, start: failureSince!, reason: r.reason })
    if (notify)
      for (const channel of channels.results)
        notifications.push({
          id: `check:${resultId}:${channel.id}`,
          channel: channel.id,
          message: renderNotificationTemplate(r.up ? templates.recovery : templates.down, {
            monitorName: m.name,
            reason: r.reason,
            time: formatNotificationTime(t, templates.timeZone),
          }),
        })
  }
  const guards = accepted.map(({ monitor: m }) => ({
    id: m.id,
    version: m.version,
    previous: previous.get(m.id)?.result_id ?? null,
  }))
  const statements = [
    database
      .prepare(
        `UPDATE free_runtime SET state=? WHERE id=1 AND token=? AND lease_until>?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN monitors m ON m.id=json_extract(j.value,'$.id')
        WHERE m.id IS NULL OR m.enabled<>1 OR m.version<>json_extract(j.value,'$.version')
        OR (SELECT result_id FROM current_monitor_state WHERE monitor_id=m.id) IS NOT json_extract(j.value,'$.previous'))`
      )
      .bind(JSON.stringify(state), token, now(), JSON.stringify(guards)),
    database.prepare('INSERT INTO result_guard(id,ok) VALUES (?,changes())').bind(token),
    database
      .prepare(
        'INSERT INTO free_history(hour,samples) VALUES (?,?) ON CONFLICT(hour) DO UPDATE SET samples=excluded.samples'
      )
      .bind(hour, JSON.stringify(samples)),
    ...[...changedDays].map((d) =>
      database
        .prepare(
          'INSERT INTO free_daily(day,totals) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET totals=excluded.totals'
        )
        .bind(d, JSON.stringify(days.get(d)))
    ),
  ]
  if (closed.length)
    statements.push(
      database
        .prepare(
          `UPDATE monitor_outages SET end_at=(SELECT json_extract(j.value,'$.end') FROM json_each(?) j WHERE json_extract(j.value,'$.id')=monitor_id)
    WHERE end_at IS NULL AND monitor_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`
        )
        .bind(JSON.stringify(closed), JSON.stringify(closed))
    )
  if (opened.length)
    statements.push(
      database
        .prepare(
          `INSERT INTO monitor_outages(id,monitor_id,start_at,end_at,reason)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.monitor'),json_extract(value,'$.start'),NULL,json_extract(value,'$.reason') FROM json_each(?)`
        )
        .bind(JSON.stringify(opened))
    )
  if (notifications.length)
    statements.push(
      database
        .prepare(
          `INSERT OR IGNORE INTO notification_outbox(id,channel_id,message,available_at,created_at)
    SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.channel'),json_extract(j.value,'$.message'),?,? FROM json_each(?) j
    JOIN notification_channels c ON c.id=json_extract(j.value,'$.channel') WHERE c.enabled=1`
        )
        .bind(t, t, JSON.stringify(notifications))
    )
  statements.push(database.prepare('DELETE FROM result_guard WHERE id=?').bind(token))
  try {
    await database.batch(statements)
  } catch (e) {
    if (!String(e).includes('CHECK constraint failed')) throw e
    console.warn('Discarded superseded probe batch')
  }
}
