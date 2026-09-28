// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { z } from 'zod'
import type { Env } from './env'
import type { MonitorRow, ProbeConfig, Component, Group, StatusEvent } from '../shared/models'
import {
  audit,
  body,
  db,
  HttpError,
  idSchema,
  json,
  now,
  seal,
  unseal,
  uuid,
  invalidatePublic,
} from './core'
import { authorize } from './auth'
import {
  channelSchema,
  channelConfigSchema,
  componentSchema,
  eventSchema,
  groupSchema,
  monitorSchema,
  settingsSchema,
  notificationTemplatesSchema,
} from './validation'
import { loadEvents, publicData, eventUpdates } from './public'
import { enqueueNotification, sendWebhook, notificationError } from './notifications'
import { loadNotificationTemplates } from './notification-templates'
import { notificationTestScenarios, renderNotificationTest } from '../shared/notification-templates'
import {
  notificationSeverityLabels,
  notificationKindLabels,
} from '../shared/notification-templates'
import {
  renderNotificationTemplate,
  formatNotificationTime,
} from '../shared/notification-templates'
import { statusLabels } from '../shared/models'
import { importPrepared } from './prepared-import'
import { canExportEncryptionKey, exportEncryptionKey } from './key-backup'
import { POLICY as policy } from '../shared/policy'
import { compactHistory, mergeDaily } from './compact-history'
import type { DailyStat } from '../shared/models'

export async function api(request: Request, env: Env) {
  const url = new URL(request.url),
    path = url.pathname.replace(/\/$/, ''),
    method = request.method
  if (path === '/api/health' && method === 'GET') return json({ ok: true })
  const updatePath = /^\/api\/(admin\/)?incidents\/([a-zA-Z0-9_-]{1,80})\/updates$/.exec(path)
  if (updatePath && method === 'GET') {
    if (updatePath[1]) await authorize(request, env)
    return json(
      await eventUpdates(
        db(env),
        updatePath[2],
        url.searchParams.get('cursor') || undefined,
        !updatePath[1]
      )
    )
  }
  if (path === '/api/status' && method === 'GET') return json(await publicData(env))
  if (path === '/api/data' && method === 'GET') {
    const data = await publicData(env)
    const response = json({
      up: data.monitors.filter((m) => m.status === 'up').length,
      down: data.monitors.filter((m) => m.status === 'down').length,
      unknown: data.monitors.filter((m) => m.status === 'unknown').length,
      updatedAt: Math.max(0, ...data.monitors.map((m) => m.checked_at || 0)),
      monitors: Object.fromEntries(
        data.monitors.map((m) => [
          m.id,
          {
            up: m.status === 'up' ? true : m.status === 'down' ? false : null,
            latency: m.latency,
            location: 'Cloudflare',
            message: m.status === 'up' ? 'OK' : m.status,
            status: m.status,
          },
        ])
      ),
      maintenances: data.events
        .filter((e) => e.kind === 'maintenance')
        .map((e) => ({
          title: e.title,
          body: e.updates[0]?.body || '',
          start: new Date(e.start_at * 1000).toISOString(),
          end: e.end_at ? new Date(e.end_at * 1000).toISOString() : undefined,
          monitors: data.monitors
            .filter((m) => e.components.includes(m.component_id))
            .map((m) => m.id),
        })),
    })
    response.headers.set('Access-Control-Allow-Origin', '*')
    return response
  }
  if (path === '/api/badge' && method === 'GET') {
    const id = url.searchParams.get('id'),
      label = (url.searchParams.get('label') || id || 'StatusFlare').slice(0, 200)
    let monitor: { status: string } | undefined
    const m = await db(env)
      .prepare(
        'SELECT m.enabled,m.interval,m.version,s.status,s.version AS result_version,s.checked_at FROM monitors m JOIN components c ON c.id=m.component_id LEFT JOIN current_monitor_state s ON s.monitor_id=m.id WHERE m.id=? AND c.public=1'
      )
      .bind(id)
      .first<{
        enabled: number
        interval: number
        version: number
        result_version: number
        checked_at: number
        status: string
      }>()
    if (m)
      monitor = {
        status: !m.enabled
          ? 'paused'
          : !m.checked_at ||
            m.version !== m.result_version ||
            now() - m.checked_at > m.interval * 2 + 30
          ? 'unknown'
          : m.status,
      }
    if (!monitor)
      return json(
        { schemaVersion: 1, label, message: 'no-monitor', color: 'lightgrey', isError: true },
        id ? 404 : 400
      )
    const up = monitor.status === 'up',
      down = monitor.status === 'down'
    return json({
      schemaVersion: 1,
      label,
      message: (up
        ? url.searchParams.get('up') || 'UP'
        : down
        ? url.searchParams.get('down') || 'DOWN'
        : monitor.status.toUpperCase()
      ).slice(0, 200),
      color: (up
        ? url.searchParams.get('colorUp') || 'brightgreen'
        : down
        ? url.searchParams.get('colorDown') || 'red'
        : 'lightgrey'
      ).slice(0, 80),
    })
  }
  const history = /^\/api\/monitors\/([a-zA-Z0-9_-]{1,80})\/history$/.exec(path)
  if (history && method === 'GET') {
    const database = db(env),
      id = history[1]
    if (
      !(await database
        .prepare(
          'SELECT m.id FROM monitors m JOIN components c ON c.id=m.component_id WHERE m.id=? AND c.public=1'
        )
        .bind(id)
        .first())
    )
      throw new HttpError(404, '监控不存在')
    const [samples, outages, daily, compact] = await Promise.all([
      database
        .prepare(
          'SELECT checked_at,up,latency FROM check_results WHERE monitor_id=? AND checked_at>=? ORDER BY checked_at LIMIT 800'
        )
        .bind(id, now() - 12 * 3600)
        .all(),
      database
        .prepare(
          'SELECT id,start_at,end_at FROM monitor_outages WHERE monitor_id=? AND (end_at IS NULL OR end_at>=?) ORDER BY start_at DESC LIMIT 100'
        )
        .bind(id, now() - 90 * 86400)
        .all(),
      database
        .prepare('SELECT * FROM daily_stats WHERE monitor_id=? AND day>=? ORDER BY day')
        .bind(id, Math.floor(now() / 86400) * 86400 - 89 * 86400)
        .all<DailyStat>(),
      compactHistory(env, id),
    ])
    const points = new Map([...samples.results, ...compact.samples].map((s) => [s.checked_at, s]))
    return json({
      samples: [...points.values()].sort((a, b) => Number(a.checked_at) - Number(b.checked_at)),
      outages: outages.results,
      daily: mergeDaily([...daily.results, ...compact.daily]),
    })
  }
  if (path === '/api/incidents' && method === 'GET') {
    const events = await loadEvents(db(env), true, {
      history: true,
      cursor: url.searchParams.get('cursor') || undefined,
      limit: policy.publicPageSize,
      updateLimit: 1,
    })
    const last = events.at(-1)
    return json({
      events,
      nextCursor:
        events.length === policy.publicPageSize && last ? `${last.start_at}:${last.id}` : null,
    })
  }
  if (path.startsWith('/attachments/') && method === 'GET')
    return attachment(request, env, path.split('/')[2])
  if (!path.startsWith('/api/admin')) throw new HttpError(404, '接口不存在')
  const actor = await authorize(request, env),
    database = db(env)
  if (method !== 'GET') {
    const used = await database
      .prepare('SELECT writes FROM free_usage WHERE day=?')
      .bind(Math.floor(now() / 86400))
      .first<{ writes: number }>()
    if ((used?.writes || 0) >= policy.writeBudget)
      throw new HttpError(429, '今日应用写入预算已用完，UTC 次日恢复；公开页面仍可读取')
  }
  if (path === '/api/admin/encryption-key/export') return exportEncryptionKey(request, env, actor)
  if (path === '/api/admin/me' && method === 'GET')
    return json({ actor, storage: !!env.STORAGE, policy })
  if (path === '/api/admin/activity/clear' && method === 'POST') {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(await body(request, 1024))
    // Clear both tables atomically, including records outside the overview's 100-row limit.
    // Do not insert another audit entry: the requested result is an empty audit log.
    const [deliveries, audits] = await database.batch([
      database.prepare('DELETE FROM notification_outbox'),
      database.prepare('DELETE FROM audit_logs'),
    ])
    return json({
      ok: true,
      deleted: { deliveries: deliveries.meta.changes, audits: audits.meta.changes },
    })
  }
  if (path === '/api/admin/overview' && method === 'GET') {
    const [
      groups,
      components,
      monitors,
      events,
      channels,
      page,
      deliveries,
      audits,
      usage,
      notificationTemplates,
    ] = await Promise.all([
      database.prepare('SELECT * FROM groups ORDER BY position,name').all<Group>(),
      database.prepare('SELECT * FROM components ORDER BY position,name').all<Component>(),
      database
        .prepare(
          'SELECT m.*,s.status,s.checked_at,s.latency,s.version AS result_version FROM monitors m LEFT JOIN current_monitor_state s ON s.monitor_id=m.id ORDER BY m.position,m.created_at,m.id'
        )
        .all<MonitorRow>(),
      loadEvents(database, false, {
        history: true,
        limit: policy.publicPageSize,
        updateLimit: 1,
      }),
      database
        .prepare('SELECT id,name,enabled,version FROM notification_channels ORDER BY name')
        .all(),
      database.prepare("SELECT value FROM settings WHERE key='page'").first<{ value: string }>(),
      database
        .prepare(
          'SELECT id,channel_id,state,attempts,error,created_at FROM notification_outbox ORDER BY created_at DESC LIMIT 100'
        )
        .all(),
      database.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100').all(),
      database
        .prepare('SELECT * FROM free_usage WHERE day=?')
        .bind(Math.floor(now() / 86400))
        .first(),
      loadNotificationTemplates(database),
    ])
    const summaries = await Promise.all(
      monitors.results.map(async ({ config, ...m }) => {
        const { method, target } = await unseal<ProbeConfig>(env, config)
        return { ...m, probeSummary: { method, target } }
      })
    )
    return json({
      actor,
      groups: groups.results,
      components: components.results,
      monitors: summaries,
      events,
      eventsNextCursor:
        events.length === policy.publicPageSize
          ? `${events.at(-1)!.start_at}:${events.at(-1)!.id}`
          : null,
      channels: channels.results,
      settings: page ? JSON.parse(page.value) : {},
      notificationTemplates,
      deliveries: deliveries.results,
      audits: audits.results,
      storage: !!env.STORAGE,
      keyExportEnabled: canExportEncryptionKey(env, actor),
      policy,
      usage,
    })
  }
  if (path === '/api/admin/settings/notification-templates' && method === 'PUT') {
    const value = notificationTemplatesSchema.parse(await body(request, 65536))
    await database.batch([
      database
        .prepare(
          "INSERT INTO settings VALUES ('notification_templates',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        )
        .bind(JSON.stringify(value)),
      audit(database, actor, 'settings.update', 'notification_templates'),
    ])
    return json(value)
  }
  if (path === '/api/admin/settings' && method === 'PUT') {
    const value = settingsSchema.parse(await body(request, 65536))
    await database.batch([
      database
        .prepare(
          "INSERT INTO settings VALUES ('page',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        )
        .bind(JSON.stringify(value)),
      audit(database, actor, 'settings.update', 'page'),
      invalidatePublic(database),
    ])
    return json(value)
  }
  const match =
    /^\/api\/admin\/(groups|components|monitors|events|channels)(?:\/([a-zA-Z0-9_-]{1,80}))?(?:\/(check|import-history|test))?$/.exec(
      path
    )
  if (match) {
    const [, kind, pathId, action] = match
    if (action === 'test' && kind === 'channels' && pathId && method === 'POST') {
      const testInput = await body(request, 65536, true)
      const templateTest =
        testInput === undefined
          ? null
          : z
              .object({
                templates: notificationTemplatesSchema,
                scenario: z.enum(notificationTestScenarios),
              })
              .strict()
              .parse(testInput)
      const saved = await database
        .prepare('SELECT config FROM notification_channels WHERE id=?')
        .bind(pathId)
        .first<{ config: string }>()
      if (!saved) throw new HttpError(404, '通知渠道不存在')
      const started = Date.now()
      let result: { ok: boolean; log: string; elapsedMs: number }
      const message = templateTest
        ? renderNotificationTest(templateTest.templates, templateTest.scenario, now())
        : `StatusFlare 测试通知\n这是一条手动测试消息，不代表实际故障。\n${new Date().toISOString()}`
      await audit(
        database,
        actor,
        templateTest ? 'channel.template-test' : 'channel.test',
        pathId
      ).run()
      try {
        const config = channelConfigSchema.parse(await unseal(env, saved.config))
        const status = await sendWebhook(config, message, env)
        result = {
          ok: true,
          log: `接收端返回 HTTP ${status}。请确认目标应用收到测试消息；HTTP 成功不代表业务处理一定成功。`,
          elapsedMs: Date.now() - started,
        }
      } catch (error) {
        result = { ok: false, log: notificationError(error), elapsedMs: Date.now() - started }
      }
      return json(result)
    }
    const table = {
      groups: 'groups',
      components: 'components',
      monitors: 'monitors',
      events: 'events',
      channels: 'notification_channels',
    }[kind]!
    if (!action && method === 'GET' && kind === 'events' && !pathId) {
      const events = await loadEvents(database, false, {
          history: true,
          cursor: url.searchParams.get('cursor') || undefined,
          limit: policy.publicPageSize,
          updateLimit: 1,
        }),
        last = events.at(-1)
      return json({
        events,
        nextCursor:
          events.length === policy.publicPageSize && last ? `${last.start_at}:${last.id}` : null,
      })
    }
    if (!action && method === 'GET' && kind === 'monitors' && pathId) {
      const m = await database
        .prepare('SELECT * FROM monitors WHERE id=?')
        .bind(pathId)
        .first<MonitorRow>()
      if (!m) throw new HttpError(404, '监控不存在')
      return json({ ...m, config: await unseal<ProbeConfig>(env, m.config) })
    }
    if (!action && method === 'GET' && kind === 'channels' && pathId) {
      const channel = await database
        .prepare('SELECT * FROM notification_channels WHERE id=?')
        .bind(pathId)
        .first<{ config: string }>()
      if (!channel) throw new HttpError(404, '通知渠道不存在')
      return json({
        ...channel,
        config: await unseal<z.infer<typeof channelConfigSchema>>(env, channel.config),
      })
    }
    if (action === 'import-history' && kind === 'monitors' && pathId && method === 'POST')
      return json(await importPrepared(env, pathId, await body(request, 65536), actor))
    if (action === 'check' && kind === 'monitors' && pathId && method === 'POST') {
      const updated = await database
        .prepare(
          'UPDATE monitors SET next_check_at=0,manual_check_at=? WHERE id=? AND enabled=1 RETURNING id'
        )
        .bind(now() + 1, pathId)
        .first()
      if (!updated) throw new HttpError(404, '监控不存在或已暂停')
      await audit(database, actor, 'monitor.check', pathId).run()
      return json({ message: '已安排下一轮检查，受每分钟额度和最小间隔限制，繁忙时会顺延' })
    }
    if (!action && method === 'DELETE' && pathId) {
      const version = z.coerce.number().int().positive().parse(url.searchParams.get('version'))
      // Disable monitors instead of deleting them to preserve their history.
      if (kind === 'monitors') throw new HttpError(400, '请暂停监控以保留历史记录')
      const result = await database.batch([
        database.prepare(`DELETE FROM ${table} WHERE id=? AND version=?`).bind(pathId, version),
        audit(database, actor, `${kind}.delete`, pathId),
        invalidatePublic(database),
      ])
      if (!result[0].meta.changes) throw new HttpError(409, '记录已变化，请刷新后重试')
      return json({ ok: true })
    }
    if (!action && ((method === 'POST' && !pathId) || (method === 'PUT' && pathId))) {
      const input = await body(request, 65536),
        id = idSchema.parse(pathId ?? (input.id === undefined ? uuid() : input.id)),
        creating = method === 'POST'
      const exists = await database
        .prepare(`SELECT id,version FROM ${table} WHERE id=?`)
        .bind(id)
        .first<{ id: string; version: number }>()
      if (creating && exists) throw new HttpError(409, 'ID 已存在；导入不会覆盖已有数据')
      if (!creating && !exists) throw new HttpError(404, '记录不存在')
      if (!creating && input.version !== exists!.version)
        throw new HttpError(409, '记录已变化，请刷新后重试')
      const statements: D1PreparedStatement[] = []
      let capacityGuard: string | undefined
      if (kind === 'groups') {
        const v = groupSchema.parse({ ...input, id })
        statements.push(
          creating
            ? database
                .prepare('INSERT INTO groups(id,name,position) VALUES (?,?,?)')
                .bind(id, v.name, v.position)
            : database
                .prepare(
                  'UPDATE groups SET name=?,position=?,version=version+1 WHERE id=? AND version=?'
                )
                .bind(v.name, v.position, id, v.version!)
        )
      } else if (kind === 'components') {
        const v = componentSchema.parse({ ...input, id })
        statements.push(
          creating
            ? database
                .prepare(
                  'INSERT INTO components(id,name,description,group_id,public,position,link) VALUES (?,?,?,?,?,?,?)'
                )
                .bind(id, v.name, v.description, v.group_id, v.public, v.position, v.link)
            : database
                .prepare(
                  'UPDATE components SET name=?,description=?,group_id=?,public=?,position=?,link=?,version=version+1 WHERE id=? AND version=?'
                )
                .bind(
                  v.name,
                  v.description,
                  v.group_id,
                  v.public,
                  v.position,
                  v.link,
                  id,
                  v.version!
                )
        )
      } else if (kind === 'monitors') {
        const v = monitorSchema.parse({ interval: policy.defaultInterval, ...input, id }),
          encrypted = await seal(env, v.config)
        if (v.interval < policy.minimumInterval)
          throw new HttpError(400, `检查间隔至少 ${policy.minimumInterval} 秒`)
        if (new TextEncoder().encode(JSON.stringify(v.config)).length > 8192)
          throw new HttpError(400, '检测配置上限为 8 KiB')
        capacityGuard = uuid()
        statements.push(
          database
            .prepare(
              `INSERT INTO result_guard(id,ok) SELECT ?,CASE WHEN (SELECT COUNT(*) FROM monitors WHERE id<>?)<? AND COALESCE((SELECT SUM(86400.0/interval) FROM monitors WHERE enabled=1 AND id<>?),0)+?<=? THEN 1 ELSE 0 END`
            )
            .bind(
              capacityGuard,
              id,
              policy.maxMonitors,
              id,
              v.enabled ? 86400 / v.interval : 0,
              policy.checksPerDay + 0.00001
            )
        )
        statements.push(
          creating
            ? database
                .prepare(
                  'INSERT INTO monitors(id,name,component_id,config,enabled,interval,grace,notify,position,link,created_at,import_owner) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
                )
                .bind(
                  id,
                  v.name,
                  v.component_id,
                  encrypted,
                  v.enabled,
                  v.interval,
                  v.grace,
                  v.notify,
                  v.position,
                  v.link,
                  now(),
                  input.import_key ? z.string().uuid().parse(input.import_key) : null
                )
            : database
                .prepare(
                  'UPDATE monitors SET name=?,component_id=?,config=?,enabled=?,interval=?,grace=?,notify=?,position=?,link=?,version=version+1,next_check_at=0 WHERE id=? AND version=?'
                )
                .bind(
                  v.name,
                  v.component_id,
                  encrypted,
                  v.enabled,
                  v.interval,
                  v.grace,
                  v.notify,
                  v.position,
                  v.link,
                  id,
                  v.version!
                )
        )
      } else if (kind === 'channels') {
        const v = channelSchema.parse(input)
        if (v.enabled) {
          capacityGuard = uuid()
          statements.push(
            database
              .prepare(
                'INSERT INTO result_guard(id,ok) SELECT ?,CASE WHEN (SELECT COUNT(*) FROM notification_channels WHERE enabled=1 AND id<>?)<? THEN 1 ELSE 0 END'
              )
              .bind(capacityGuard, id, policy.maxChannels)
          )
        }
        if (v.config && new TextEncoder().encode(JSON.stringify(v.config)).length > 8192)
          throw new HttpError(400, '渠道配置上限为 8 KiB')
        if (creating && !v.config) throw new HttpError(400, '需要 Webhook 配置')
        if (creating)
          statements.push(
            database
              .prepare('INSERT INTO notification_channels(id,name,config,enabled) VALUES (?,?,?,?)')
              .bind(id, v.name, await seal(env, v.config), v.enabled)
          )
        else if (v.config)
          statements.push(
            database
              .prepare(
                'UPDATE notification_channels SET name=?,config=?,enabled=?,version=version+1 WHERE id=? AND version=?'
              )
              .bind(v.name, await seal(env, v.config), v.enabled, id, v.version!)
          )
        else
          statements.push(
            database
              .prepare(
                'UPDATE notification_channels SET name=?,enabled=?,version=version+1 WHERE id=? AND version=?'
              )
              .bind(v.name, v.enabled, id, v.version!)
          )
      } else {
        const v = eventSchema.parse({ ...input, id }),
          t = now()
        if (
          v.components.length > policy.eventComponents ||
          v.attachments.length > policy.eventAttachments
        )
          throw new HttpError(
            400,
            `每个公告最多关联 ${policy.eventComponents} 项服务、${policy.eventAttachments} 个新附件`
          )
        if (new TextEncoder().encode(v.body).length > 8192)
          throw new HttpError(400, '每条进展正文上限为 8 KiB')
        const selectedChannels = [...new Set(v.notificationChannels)]
        if (selectedChannels.length) {
          const channels = await database
            .prepare(
              `SELECT id FROM notification_channels WHERE enabled=1 AND id IN (${selectedChannels
                .map(() => '?')
                .join(',')})`
            )
            .bind(...selectedChannels)
            .all<{ id: string }>()
          if (channels.results.length !== selectedChannels.length)
            throw new HttpError(400, '通知渠道不存在或已停用，请重新选择启用的渠道')
        }
        let serviceNames = ''
        if (v.published) {
          const components = await database
            .prepare(
              `SELECT id,name FROM components WHERE public=1 AND id IN (${v.components
                .map(() => '?')
                .join(',')})`
            )
            .bind(...v.components)
            .all<{ id: string; name: string }>()
          if (components.results.length !== new Set(v.components).size)
            throw new HttpError(400, '公开公告只能关联公开服务')
          const names = new Map(
            components.results.map((component) => [component.id, component.name])
          )
          serviceNames = [...new Set(v.components)].map((id) => names.get(id)!).join('、')
        }
        if (creating)
          statements.push(
            database
              .prepare(
                'INSERT INTO events(id,kind,title,status,severity,start_at,end_at,published,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
              )
              .bind(
                id,
                v.kind,
                v.title,
                v.status,
                v.severity,
                v.start_at,
                v.end_at,
                v.published,
                t,
                t,
                v.published ? t : null
              )
          )
        const condition = creating ? 'id=?' : 'id=? AND version=?',
          bindings = creating ? [id] : [id, v.version!]
        statements.push(
          database
            .prepare(
              `DELETE FROM event_components WHERE event_id IN (SELECT id FROM events WHERE ${condition})`
            )
            .bind(...bindings)
        )
        for (const component of new Set(v.components))
          statements.push(
            database
              .prepare(`INSERT INTO event_components SELECT id,? FROM events WHERE ${condition}`)
              .bind(component, ...bindings)
          )
        if (v.body)
          statements.push(
            database
              .prepare(`INSERT INTO event_updates SELECT ?,id,?,?,? FROM events WHERE ${condition}`)
              .bind(uuid(), v.status, v.body, t, ...bindings)
          )
        for (const attachmentId of v.attachments)
          statements.push(
            database
              .prepare(
                `INSERT OR IGNORE INTO event_attachments SELECT id,? FROM events WHERE ${condition}`
              )
              .bind(attachmentId, ...bindings)
          )
        if (v.published && selectedChannels.length) {
          const templates = await loadNotificationTemplates(database)
          statements.push(
            enqueueNotification(
              database,
              `event:${id}:${creating ? 1 : v.version! + 1}`,
              renderNotificationTemplate(templates.event, {
                title: v.title,
                kind: notificationKindLabels[v.kind],
                status: statusLabels[v.status] ?? v.status,
                severity: notificationSeverityLabels[v.severity],
                services: serviceNames,
                body: v.body,
                time: formatNotificationTime(t, templates.timeZone),
                startTime: formatNotificationTime(v.start_at, templates.timeZone),
                endTime:
                  v.end_at === null ? '待定' : formatNotificationTime(v.end_at, templates.timeZone),
              }),
              `id IN (${selectedChannels
                .map(() => '?')
                .join(',')}) AND EXISTS(SELECT 1 FROM events WHERE ${condition})`,
              [...selectedChannels, ...bindings],
              policy.maxChannels
            )
          )
        }
        // Compare-and-swap is last; the entire D1 batch is one transaction.
        statements.push(
          creating
            ? database.prepare('UPDATE events SET updated_at=? WHERE id=?').bind(t, id)
            : database
                .prepare(
                  'UPDATE events SET kind=?,title=?,status=?,severity=?,start_at=?,end_at=?,published=?,updated_at=?,published_at=CASE WHEN ?=1 THEN COALESCE(published_at,?) ELSE published_at END,version=version+1 WHERE id=? AND version=?'
                )
                .bind(
                  v.kind,
                  v.title,
                  v.status,
                  v.severity,
                  v.start_at,
                  v.end_at,
                  v.published,
                  t,
                  v.published,
                  t,
                  id,
                  v.version!
                )
        )
      }
      const changeIndex = statements.length - 1
      if (capacityGuard)
        statements.push(database.prepare('DELETE FROM result_guard WHERE id=?').bind(capacityGuard))
      statements.push(audit(database, actor, `${kind}.${creating ? 'create' : 'update'}`, id))
      statements.push(invalidatePublic(database))
      const result = await database.batch(statements).catch((error: unknown) => {
        if (
          kind === 'channels' &&
          capacityGuard &&
          String(error).includes('CHECK constraint failed')
        )
          throw new HttpError(
            409,
            `最多同时启用 ${policy.maxChannels} 个通知渠道，请先停用其他渠道`
          )
        throw error
      })
      if (!creating && !result[changeIndex].meta.changes)
        throw new HttpError(409, '记录已变化，请刷新后重试')
      return json({ id }, creating ? 201 : 200)
    }
  }
  if (path === '/api/admin/attachments' && method === 'POST') {
    if (!env.STORAGE) throw new HttpError(503, '尚未绑定 R2 存储')
    const type = request.headers.get('content-type') || ''
    if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain'].includes(type))
      throw new HttpError(400, '支持 PNG、JPEG、WebP、PDF 和纯文本')
    const reader = request.body?.getReader()
    if (!reader) throw new HttpError(400, '文件为空')
    const parts: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 1024 * 1024) {
        await reader.cancel()
        throw new HttpError(413, '附件上限为 1 MiB')
      }
      parts.push(value)
    }
    const bytes = new Uint8Array(size)
    let at = 0
    for (const p of parts) {
      bytes.set(p, at)
      at += p.length
    }
    const id = uuid(),
      key = `attachments/${id}`,
      name = decodeURIComponent(request.headers.get('x-file-name') || 'attachment').slice(0, 200)
    await env.STORAGE.put(key, bytes, { httpMetadata: { contentType: type } })
    try {
      await database.batch([
        database
          .prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?)')
          .bind(id, key, name, type, size, now()),
        audit(database, actor, 'attachment.upload', id),
      ])
    } catch (e) {
      await env.STORAGE.delete(key)
      throw e
    }
    return json({ id, url: `/attachments/${id}`, name }, 201)
  }
  const retry = /^\/api\/admin\/deliveries\/([^/]+)\/retry$/.exec(path)
  if (retry && method === 'POST') {
    await database.batch([
      database
        .prepare(
          "UPDATE notification_outbox SET state='pending',attempts=0,available_at=?,lease_until=0 WHERE id=? AND state='failed'"
        )
        .bind(now(), decodeURIComponent(retry[1])),
      audit(database, actor, 'notification.retry', retry[1]),
    ])
    return json({ ok: true })
  }
  throw new HttpError(404, '接口不存在')
}
async function attachment(request: Request, env: Env, id: string) {
  if (!env.STORAGE) throw new HttpError(404, '附件不存在')
  const database = db(env)
  const visible = await database
    .prepare(
      `SELECT 1 FROM event_attachments ea JOIN events e ON e.id=ea.event_id WHERE ea.attachment_id=? AND e.published=1 AND NOT EXISTS(SELECT 1 FROM event_components ec JOIN components c ON c.id=ec.component_id WHERE ec.event_id=e.id AND c.public=0) LIMIT 1`
    )
    .bind(id)
    .first()
  if (!visible) await authorize(request, env)
  const meta = await database
    .prepare('SELECT * FROM attachments WHERE id=?')
    .bind(id)
    .first<{ object_key: string; content_type: string; name: string }>()
  if (!meta) throw new HttpError(404, '附件不存在')
  const object = await env.STORAGE.get(meta.object_key)
  if (!object) throw new HttpError(404, '附件不存在')
  return new Response(object.body, {
    headers: {
      'content-type': meta.content_type,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'content-disposition': `${
        meta.content_type.startsWith('image/') ? 'inline' : 'attachment'
      }; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    },
  })
}
