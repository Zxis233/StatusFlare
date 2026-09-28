// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import type {
  Component,
  Group,
  PublicData,
  PublicMonitor,
  StatusEvent,
  EventUpdate,
} from '../shared/models'
import type { Env } from './env'
import { db, now, HttpError } from './core'
import { POLICY } from '../shared/policy'
export async function loadEvents(
  database: D1DatabaseSession,
  isPublic = false,
  options: { cursor?: string; history?: boolean; limit?: number; updateLimit?: number } = {}
): Promise<StatusEvent[]> {
  const t = now()
  const cursor = options.cursor?.match(/^(\d+):([a-zA-Z0-9_-]{1,80})$/)
  if (options.cursor && !cursor) throw new HttpError(400, '分页游标无效')
  const rows = await database
    .prepare(
      `SELECT * FROM events e WHERE ${
        isPublic
          ? 'published=1 AND NOT EXISTS (SELECT 1 FROM event_components ec JOIN components c ON c.id=ec.component_id WHERE ec.event_id=e.id AND c.public=0)'
          : '1=1'
      } ${cursor ? 'AND (start_at < ? OR (start_at = ? AND id < ?))' : ''} ORDER BY ${
        options.history
          ? ''
          : `CASE WHEN status NOT IN ('resolved','completed','cancelled') AND NOT(kind='maintenance' AND end_at IS NOT NULL AND end_at<=${t}) THEN 0 ELSE 1 END, `
      }start_at DESC,id DESC LIMIT ${options.limit || 100}`
    )
    .bind(...(cursor ? [Number(cursor[1]), Number(cursor[1]), cursor[2]] : []))
    .all<Omit<StatusEvent, 'components' | 'updates'>>()
  if (!rows.results.length) return []
  const ids = rows.results.map((r) => r.id),
    placeholders = ids.map(() => '?').join(',')
  const [links, updates] = await Promise.all([
    database
      .prepare(`SELECT * FROM event_components WHERE event_id IN (${placeholders})`)
      .bind(...ids)
      .all<{ event_id: string; component_id: string }>(),
    database
      .prepare(
        options.updateLimit
          ? ids
              .map(
                () =>
                  `SELECT * FROM (SELECT * FROM event_updates WHERE event_id=? ORDER BY created_at DESC,id DESC LIMIT ${
                    options.updateLimit! + 1
                  })`
              )
              .join(' UNION ALL ')
          : `SELECT * FROM event_updates WHERE event_id IN (${placeholders}) ORDER BY created_at DESC, id DESC`
      )
      .bind(...ids)
      .all<EventUpdate>(),
  ])
  return rows.results.map((e) => ({
    ...e,
    status:
      isPublic &&
      e.kind === 'maintenance' &&
      ['scheduled', 'in_progress'].includes(e.status) &&
      e.start_at <= t
        ? e.end_at !== null && e.end_at <= t
          ? 'completed'
          : 'in_progress'
        : e.status,
    components: links.results.filter((l) => l.event_id === e.id).map((l) => l.component_id),
    updates: updates.results.filter((u) => u.event_id === e.id).slice(0, options.updateLimit),
    moreUpdates:
      !!options.updateLimit &&
      updates.results.filter((u) => u.event_id === e.id).length > options.updateLimit,
  }))
}
export async function publicData(env: Env): Promise<PublicData> {
  const database = db(env),
    t = now()
  const [page, groups, components, monitors, events] = await Promise.all([
    database.prepare("SELECT value FROM settings WHERE key='page'").first<{ value: string }>(),
    database.prepare('SELECT * FROM groups ORDER BY position,name').all<Group>(),
    database
      .prepare('SELECT * FROM components WHERE public=1 ORDER BY position,name')
      .all<Component>(),
    database
      .prepare(
        `SELECT m.id,m.name,m.link,m.component_id,m.enabled,m.interval,m.version,s.status,s.checked_at,s.latency,s.version AS result_version FROM monitors m JOIN components c ON c.id=m.component_id LEFT JOIN current_monitor_state s ON s.monitor_id=m.id WHERE c.public=1 ORDER BY m.position,m.created_at,m.id`
      )
      .all<{
        id: string
        name: string
        link: string
        component_id: string
        enabled: number
        interval: number
        version: number
        status: 'up' | 'down'
        checked_at: number | null
        latency: number | null
        result_version: number | null
      }>(),
    loadEvents(database, true, {
      limit: POLICY.publicPageSize,
      updateLimit: 1,
    }),
  ])
  const visibleGroups = new Set(components.results.map((c) => c.group_id))
  const output: PublicMonitor[] = monitors.results.map((m) => ({
    id: m.id,
    name: m.name,
    link: m.link,
    component_id: m.component_id,
    status: !m.enabled
      ? 'paused'
      : !m.checked_at || m.version !== m.result_version || t - m.checked_at > m.interval * 2 + 30
      ? 'unknown'
      : m.status,
    checked_at: m.checked_at,
    latency: m.latency,
    history: [], // Detailed history is loaded on demand by the monitor history endpoint.
  }))
  return {
    settings: page ? JSON.parse(page.value) : { title: '服务状态', description: '' },
    groups: groups.results.filter((g) => visibleGroups.has(g.id)),
    components: components.results,
    monitors: output,
    events,
    now: t,
    refreshSeconds: POLICY.publicRefreshSeconds,
  }
}
export async function eventUpdates(
  database: D1DatabaseSession,
  id: string,
  cursor?: string,
  isPublic = true
) {
  const marker = cursor?.match(/^(\d+):([a-zA-Z0-9_-]{1,80})$/)
  if (cursor && !marker) throw new HttpError(400, '分页游标无效')
  const exists = await database
    .prepare(
      `SELECT id FROM events e WHERE id=? ${
        isPublic
          ? 'AND published=1 AND NOT EXISTS(SELECT 1 FROM event_components ec JOIN components c ON c.id=ec.component_id WHERE ec.event_id=e.id AND c.public=0)'
          : ''
      }`
    )
    .bind(id)
    .first()
  if (!exists) throw new HttpError(404, '事件不存在')
  const rows = await database
    .prepare(
      `SELECT * FROM event_updates WHERE event_id=? ${
        marker ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''
      } ORDER BY created_at DESC,id DESC LIMIT 11`
    )
    .bind(id, ...(marker ? [Number(marker[1]), Number(marker[1]), marker[2]] : []))
    .all<EventUpdate>()
  const updates = rows.results.slice(0, 10),
    last = updates.at(-1)
  return {
    updates,
    nextCursor: rows.results.length > 10 && last ? `${last.created_at}:${last.id}` : null,
  }
}
