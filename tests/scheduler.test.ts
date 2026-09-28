// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
vi.mock('../server/probe', () => ({ probe: vi.fn() }))
import { database } from './database'
import { api } from '../server/api'
import { invocationEnv } from '../server/limits'
import { schedule } from '../server/scheduler'
import { cleanup } from '../server/cleanup'
import { now, db } from '../server/core'
import { prepareHistory } from '../scripts/prepare-history.mjs'
import { cachedApi } from '../server/cache'
let fixture: ReturnType<typeof database>
const config = {
  target: 'https://example.com',
  method: 'GET',
  timeout: 5000,
  headers: { Authorization: 'Bearer private-token' },
  body: '',
  expectedCodes: [],
  responseKeyword: '',
  responseForbiddenKeyword: '',
  region: '',
  fallback: false,
}
const good = { up: true, latency: 20, reason: '', location: 'test' },
  bad = { up: false, latency: 30, reason: 'HTTP 503', location: 'test' }
async function call(path: string, method = 'GET', value?: unknown) {
  const scoped = invocationEnv(fixture.env)
  const response = await api(
    new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: value ? JSON.stringify(value) : undefined,
    }),
    scoped.env
  )
  await scoped.finish()
  expect(scoped.queryCount()).toBeLessThanOrEqual(50)
  return response.json() as Promise<any>
}
async function seed(id = 'monitor', interval = 600) {
  if (!fixture.sqlite.prepare('SELECT id FROM components WHERE id=?').get('service'))
    await call('/api/admin/components', 'POST', { id: 'service', name: 'Service' })
  await call('/api/admin/monitors', 'POST', {
    id,
    name: id,
    component_id: 'service',
    config,
    interval,
    grace: 300,
  })
}
async function tick(t: number, result = good) {
  vi.setSystemTime(t * 1000)
  const scope = invocationEnv(fixture.env)
  await schedule(scope.env, t, async () => result)
  await scope.finish()
  expect(scope.queryCount()).toBeLessThanOrEqual(50)
  return scope.queryCount()
}
beforeEach(() => {
  fixture = database()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-16T12:00:00Z'))
})
afterEach(() => {
  fixture.sqlite.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('scheduler execution budgets', () => {
  it('honors a manual check on a long-interval monitor without bypassing the minute limit', async () => {
    await seed('monitor', 600)
    const t = now()
    await tick(t)
    await call('/api/admin/monitors/monitor/check', 'POST')
    await tick(t)
    expect((await call('/api/monitors/monitor/history')).samples).toHaveLength(1)
    await tick(t + 60)
    expect((await call('/api/monitors/monitor/history')).samples).toHaveLength(2)
    await tick(t + 120)
    expect((await call('/api/monitors/monitor/history')).samples).toHaveLength(2)
  })
  it('does not let repeatedly failing probe executions starve other targets', async () => {
    for (let i = 0; i < 21; i++) await seed(`fair${i.toString().padStart(2, '0')}`, 60)
    const t = now(),
      scope = invocationEnv(fixture.env)
    const failed = vi.fn(async () => {
      throw new Error('Internal probe error')
    })
    await schedule(scope.env, t, failed)
    await scope.finish()
    expect(failed).toHaveBeenCalledTimes(20)
    await tick(t + 60)
    expect(
      fixture.sqlite
        .prepare("SELECT checked_at FROM current_monitor_state WHERE monitor_id='fair20'")
        .get()!.checked_at
    ).toBe(t + 60)
  })
  it('stops launching checks and discards results after its batch lease expires', async () => {
    for (let i = 0; i < 20; i++) await seed(`expired${i}`, 60)
    const t = now(),
      scope = invocationEnv(fixture.env)
    const tester = vi.fn(async () => {
      vi.setSystemTime((t + 301) * 1000)
      return good
    })
    await schedule(scope.env, t, tester)
    await scope.finish()
    expect(tester.mock.calls.length).toBeLessThanOrEqual(5)
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM current_monitor_state').get()!.n).toBe(
      0
    )
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM free_history').get()!.n).toBe(0)
  })
  it('does not skip a one-minute monitor when the next Cron starts a second earlier', async () => {
    await seed('monitor', 60)
    const t = now()
    await tick(t + 2)
    await tick(t + 61)
    expect((await call('/api/monitors/monitor/history')).samples).toHaveLength(2)
  })
  it('caps the last daily batch at the remaining quota and resumes at UTC midnight', async () => {
    for (let i = 0; i < 20; i++) await seed(`quota${i}`, 60)
    const t = now(),
      day = Math.floor(t / 86400)
    fixture.sqlite
      .prepare(
        'INSERT INTO free_usage(day,checks) VALUES (?,47993) ON CONFLICT(day) DO UPDATE SET checks=47993'
      )
      .run(day)
    await tick(t)
    expect(
      fixture.sqlite.prepare('SELECT checks FROM free_usage WHERE day=?').get(day)!.checks
    ).toBe(48000)
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM current_monitor_state').get()!.n).toBe(
      7
    )
    await tick(t + 60)
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM current_monitor_state').get()!.n).toBe(
      7
    )
    await tick((day + 1) * 86400)
    expect(
      fixture.sqlite.prepare('SELECT checks FROM free_usage WHERE day=?').get(day + 1)!.checks
    ).toBe(20)
  })
  it('uses one atomic lease across concurrent invocations and at most five network calls concurrently', async () => {
    for (let i = 0; i < 20; i++) await seed(`parallel${i}`, 60)
    let active = 0,
      maximum = 0,
      checks = 0
    const tester = async () => {
      checks++
      active++
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active--
      return good
    }
    const a = invocationEnv(fixture.env),
      b = invocationEnv(fixture.env)
    await Promise.all([schedule(a.env, now(), tester), schedule(b.env, now(), tester)])
    await a.finish()
    await b.finish()
    expect(checks).toBe(20)
    expect(maximum).toBeLessThanOrEqual(5)
    expect(fixture.sqlite.prepare('SELECT checks FROM free_usage').get()!.checks).toBe(20)
    expect(a.queryCount()).toBeLessThanOrEqual(50)
    expect(b.queryCount()).toBeLessThanOrEqual(50)
  })
  it('rolls back state, history, outages and notifications together if persistence fails', async () => {
    await seed('monitor', 60)
    fixture.sqlite.exec(
      "CREATE TRIGGER fail_compact BEFORE INSERT ON free_daily BEGIN SELECT RAISE(ABORT,'injected disk failure'); END"
    )
    const scoped = invocationEnv(fixture.env)
    await expect(schedule(scoped.env, now(), async () => bad)).rejects.toThrow(
      'injected disk failure'
    )
    for (const table of [
      'current_monitor_state',
      'free_history',
      'free_daily',
      'monitor_outages',
      'notification_outbox',
      'result_guard',
    ])
      expect(fixture.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0)
    expect(fixture.sqlite.prepare('SELECT lease_until FROM free_runtime').get()!.lease_until).toBe(
      0
    )
    fixture.sqlite.exec('DROP TRIGGER fail_compact')
    await tick(now() + 60)
    expect((await call('/api/monitors/monitor/history')).samples).toHaveLength(1)
  })
  it('merges existing relational history with snapshots and exposes fresh state everywhere', async () => {
    await seed('monitor', 60)
    const t = now(),
      day = Math.floor(t / 86400) * 86400
    fixture.sqlite
      .prepare('INSERT INTO monitor_state VALUES (?,?,?,?,?,?,?,?)')
      .run('monitor', 'up', t - 60, 10, 1, null, 0, 'legacy')
    fixture.sqlite
      .prepare('INSERT INTO check_results VALUES (?,?,?,?,?,?,?)')
      .run('legacy', 'monitor', t - 60, 1, 10, '', 'test')
    fixture.sqlite
      .prepare('INSERT INTO daily_stats VALUES (?,?,?,?,?,?)')
      .run('monitor', day, 120, 0, 10, 1)
    await tick(t)
    const history = await call('/api/monitors/monitor/history')
    expect(history.samples).toHaveLength(2)
    expect(history.daily[0]).toMatchObject({ up_seconds: 180, latency_sum: 30, samples: 2 })
    expect((await call('/api/badge?id=monitor')).message).toBe('UP')
    expect((await call('/api/admin/overview')).monitors[0].checked_at).toBe(t)
    await call('/api/admin/monitors/monitor', 'PUT', {
      name: 'paused',
      component_id: 'service',
      config,
      interval: 60,
      enabled: 0,
      version: 1,
    })
    expect((await call('/api/status')).monitors[0].status).toBe('paused')
    await expect(
      call('/api/admin/monitors/monitor/import-history', 'POST', {
        format: 'prepared-v1',
        digest: 'b'.repeat(64),
        total: 0,
        offset: 0,
        rows: [],
      })
    ).rejects.toMatchObject({ status: 409 })
  })
  it('keeps query counts bounded for twenty simultaneous failures and recoveries with two channels', async () => {
    for (let i = 0; i < 20; i++) await seed(`storm${i}`, 60)
    fixture.sqlite.exec('UPDATE monitors SET grace=0')
    for (let i = 0; i < 2; i++)
      await call('/api/admin/channels', 'POST', {
        id: `storm-channel${i}`,
        name: 'test',
        config: { url: 'https://example.com/hook' },
      })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response('ok'))
    )
    const t = now()
    await tick(t, bad)
    expect(
      fixture.sqlite
        .prepare('SELECT COUNT(*) AS n FROM monitor_outages WHERE end_at IS NULL')
        .get()!.n
    ).toBe(20)
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()!.n).toBe(
      40
    )
    await tick(t + 60, good)
    expect(
      fixture.sqlite
        .prepare('SELECT COUNT(*) AS n FROM monitor_outages WHERE end_at IS NULL')
        .get()!.n
    ).toBe(0)
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()!.n).toBe(
      80
    )
    expect((await call('/api/monitors/storm0/history')).daily[0].down_seconds).toBe(60)
  })
  it('suppresses notifications during maintenance but still records compact outage history', async () => {
    await seed('monitor', 60)
    fixture.sqlite.exec('UPDATE monitors SET grace=0')
    await call('/api/admin/channels', 'POST', {
      id: 'channel',
      name: 'test',
      config: { url: 'https://example.com/hook' },
    })
    const t = now()
    fixture.sqlite
      .prepare(
        'INSERT INTO events(id,kind,title,status,severity,start_at,end_at,published,created_at,updated_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        'maint',
        'maintenance',
        'maintenance',
        'in_progress',
        'minor',
        t - 60,
        t + 600,
        1,
        t,
        t,
        1
      )
    fixture.sqlite.prepare('INSERT INTO event_components VALUES (?,?)').run('maint', 'service')
    await tick(t, bad)
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()!.n).toBe(0)
    expect((await call('/api/monitors/monitor/history')).outages).toHaveLength(1)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response('ok'))
    )
    await tick(t + 600, bad)
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()!.n).toBe(1)
  })
  it('sustains twenty one-minute monitors for a full UTC day within the write budget', async () => {
    const t = Math.floor(now() / 86400) * 86400
    vi.setSystemTime(t * 1000)
    for (let i = 0; i < 20; i++) await seed(`day${i}`, 60)
    let maximumQueries = 0
    for (let minute = 0; minute < 1440; minute++)
      maximumQueries = Math.max(maximumQueries, await tick(t + minute * 60))
    const usage = fixture.sqlite
      .prepare('SELECT * FROM free_usage WHERE day=?')
      .get(Math.floor(t / 86400))!
    expect(usage.checks).toBe(28800)
    expect(usage.writes).toBeLessThan(20000)
    expect(maximumQueries).toBeLessThanOrEqual(50)
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM check_jobs').get()!.n).toBe(0)
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM check_results').get()!.n).toBe(0)
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM free_history').get()!.n).toBe(24)
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM free_daily').get()!.n).toBe(1)
    const history = await call('/api/monitors/day0/history')
    expect(history.samples).toHaveLength(721)
    expect(history.daily[0]).toMatchObject({ up_seconds: 86340, down_seconds: 0, samples: 1440 })
    const status = await call('/api/status')
    expect(status.monitors.every((m: any) => m.status === 'up')).toBe(true)
    console.log(
      `24h simulation: ${usage.checks} checks, <=${usage.writes} index-inclusive writes, max ${maximumQueries} SQL/invocation`
    )
  }, 30000)
  it('checks at most twenty targets per minute fairly and ignores duplicate Cron events', async () => {
    for (let i = 0; i < 21; i++) await seed(`m${i.toString().padStart(2, '0')}`, 60)
    const t = now()
    await tick(t)
    await tick(t)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM current_monitor_state').get()!.n).toBe(
      20
    )
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM check_jobs').get()!.n).toBe(0)
    await tick(t + 60)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM current_monitor_state').get()!.n).toBe(
      21
    )
    expect(fixture.sqlite.prepare('SELECT checks FROM free_usage').get()!.checks).toBe(40)
    expect(
      fixture.sqlite
        .prepare("SELECT checked_at FROM current_monitor_state WHERE monitor_id='m20'")
        .get()!.checked_at
    ).toBe(t + 60)
  })
  it('enforces the aggregate 48000/day budget atomically and allows pausing to free capacity', async () => {
    for (let i = 0; i < 33; i++) await seed(`m${i}`, 60)
    await expect(seed('too-many', 60)).rejects.toThrow('CHECK constraint failed')
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM monitors').get()!.n).toBe(33)
    await call('/api/admin/monitors/m0', 'PUT', {
      name: 'paused',
      component_id: 'service',
      config,
      interval: 600,
      enabled: 0,
      version: 1,
    })
    await seed('replacement', 60)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM result_guard').get()!.n).toBe(0)
    await expect(
      call('/api/admin/monitors/m1', 'PUT', {
        name: 'too-fast',
        component_id: 'service',
        config,
        interval: 59,
        version: 1,
      })
    ).rejects.toThrow()
  })
  it('stays under 50 SQL across midnight recovery, two notifications and full cleanup', async () => {
    await seed()
    for (let i = 0; i < 2; i++)
      await call('/api/admin/channels', 'POST', {
        id: `channel${i}`,
        name: 'notify',
        config: { url: 'https://example.com/hook' },
      })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response('ok'))
    )
    const midnight = Math.floor(now() / 86400) * 86400 + 86400
    await tick(midnight - 1200, bad)
    await tick(midnight - 600, bad)
    for (let i = 0; i < 30; i++)
      fixture.sqlite
        .prepare('INSERT INTO check_results VALUES (?,?,?,?,?,?,?)')
        .run(`old${i}`, 'monitor', midnight - 9 * 86400, 1, 10, '', 'test')
    const count = await tick(midnight, good)
    expect(count).toBeLessThanOrEqual(45)
    const history = await call('/api/monitors/monitor/history')
    expect(history.daily.reduce((n: number, d: any) => n + d.down_seconds, 0)).toBe(1200)
    expect(
      fixture.sqlite
        .prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE state='sent'")
        .get()!.n
    ).toBe(4)
    expect(
      fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM check_results WHERE id LIKE 'old%'").get()!
        .n
    ).toBe(25)
  })
  it('ignores in-flight results after editing or pausing a monitor', async () => {
    await seed()
    const scope = invocationEnv(fixture.env)
    await schedule(scope.env, now(), async () => {
      await call('/api/admin/monitors/monitor', 'PUT', {
        name: 'paused',
        component_id: 'service',
        config,
        interval: 600,
        enabled: 0,
        version: 1,
      })
      return bad
    })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM current_monitor_state').get()!.n).toBe(
      0
    )
  })
  it('limits cleanup writes rather than deleting thousands of records in one invocation', async () => {
    await seed()
    for (let i = 0; i < 100; i++)
      fixture.sqlite
        .prepare('INSERT INTO check_results VALUES (?,?,?,?,?,?,?)')
        .run(`old${i}`, 'monitor', now() - 9 * 86400, 1, 10, '', 'test')
    const scope = invocationEnv(fixture.env)
    await cleanup(scope.env)
    expect(scope.queryCount()).toBeLessThan(12)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM check_results').get()!.n).toBe(95)
  })
  it('aborts an oversized D1 batch before any statement reaches the database', async () => {
    const scope = invocationEnv(fixture.env),
      d = db(scope.env)
    await expect(
      d.batch(
        Array.from({ length: 51 }, () => d.prepare("INSERT INTO settings VALUES ('oversize','x')"))
      )
    ).rejects.toThrow('查询预算')
    expect(
      fixture.sqlite.prepare("SELECT * FROM settings WHERE key='oversize'").get()
    ).toBeUndefined()
  })
})
describe('API limits and migration', () => {
  it('rolls back the import quota together with a failed batch', async () => {
    await seed()
    await call('/api/admin/monitors/monitor', 'PUT', {
      name: 'monitor',
      component_id: 'service',
      config,
      interval: 600,
      enabled: 0,
      version: 1,
    })
    const payload = {
      format: 'prepared-v1',
      digest: 'b'.repeat(64),
      total: 1,
      offset: 0,
      rows: [
        {
          kind: 'daily',
          day: Math.floor(now() / 86400) * 86400,
          up: 60,
          down: 0,
          latency: 20,
          samples: 1,
        },
      ],
    }
    fixture.sqlite.exec(
      "CREATE TRIGGER fail_import BEFORE INSERT ON daily_stats BEGIN SELECT RAISE(ABORT,'simulated failure'); END"
    )
    await expect(
      call('/api/admin/monitors/monitor/import-history', 'POST', payload)
    ).rejects.toThrow('simulated failure')
    expect(
      fixture.sqlite
        .prepare('SELECT imports FROM free_usage WHERE day=?')
        .get(Math.floor(now() / 86400))!.imports
    ).toBe(0)
    fixture.sqlite.exec('DROP TRIGGER fail_import')
    vi.setSystemTime((now() + 121) * 1000)
    expect(
      (await call('/api/admin/monitors/monitor/import-history', 'POST', payload)).imported
    ).toBe(true)
    expect(
      fixture.sqlite
        .prepare('SELECT imports FROM free_usage WHERE day=?')
        .get(Math.floor(now() / 86400))!.imports
    ).toBe(1)
  })
  it('preserves a migration create identity through retries and later edits', async () => {
    await call('/api/admin/components', 'POST', { id: 'service', name: 'Service' })
    const key = '11111111-2222-4333-8444-555555555555',
      value = {
        id: 'owned',
        name: 'Owned',
        component_id: 'service',
        config,
        interval: 600,
        enabled: 0,
        import_key: key,
      }
    await call('/api/admin/monitors', 'POST', value)
    await expect(call('/api/admin/monitors', 'POST', value)).rejects.toMatchObject({ status: 409 })
    expect((await call('/api/admin/monitors/owned')).import_owner).toBe(key)
    await call('/api/admin/monitors/owned', 'PUT', {
      ...value,
      version: 1,
      name: 'Edited',
      import_key: '66666666-7777-4888-8999-000000000000',
    })
    expect((await call('/api/admin/monitors/owned')).import_owner).toBe(key)
  })
  it('stops mutation work at the application write budget but leaves public reads available', async () => {
    await seed()
    fixture.sqlite
      .prepare(
        'INSERT INTO free_usage(day,writes) VALUES (?,80000) ON CONFLICT(day) DO UPDATE SET writes=80000'
      )
      .run(Math.floor(now() / 86400))
    await tick(now())
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM check_results').get()!.n).toBe(0)
    expect((await call('/api/status')).monitors).toHaveLength(1)
    await expect(call('/api/admin/groups', 'POST', { name: 'new' })).rejects.toMatchObject({
      status: 429,
    })
  })
  it('bounds the largest allowed event update below 50 SQL and rejects larger associations', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `service${i}`)
    for (const id of ids) await call('/api/admin/components', 'POST', { id, name: id })
    for (let i = 0; i < 5; i++)
      fixture.sqlite
        .prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?)')
        .run(`file${i}`, `file${i}`, 'file', 'text/plain', 5, now())
    const event = {
      id: 'event',
      kind: 'incident',
      title: 'Event',
      status: 'investigating',
      start_at: now(),
      components: ids,
      attachments: Array.from({ length: 5 }, (_, i) => `file${i}`),
      body: 'hello',
      published: 1,
    }
    await call('/api/admin/events', 'POST', event)
    await call('/api/admin/events/event', 'PUT', { ...event, version: 1, body: 'update' })
    await expect(
      call('/api/admin/events', 'POST', { ...event, id: 'large', components: [...ids, 'extra'] })
    ).rejects.toMatchObject({ status: 400 })
  })
  it('loads history and secret configuration on demand, not in public/admin overviews', async () => {
    await seed()
    await tick(now())
    await tick(now() + 600)
    const summary = await call('/api/status')
    expect(summary.monitors[0].history).toEqual([])
    const detail = await call('/api/monitors/monitor/history')
    expect(detail.daily[0].up_seconds).toBe(600)
    const admin = await call('/api/admin/overview')
    expect(admin.monitors[0]).not.toHaveProperty('config')
    expect(JSON.stringify(admin)).not.toContain('private-token')
    expect((await call('/api/admin/monitors/monitor')).config.headers.Authorization).toBe(
      'Bearer private-token'
    )
  })
  it('imports a complete legacy day in 20-row requests, resumes and never double-counts', async () => {
    await seed()
    await call('/api/admin/monitors/monitor', 'PUT', {
      name: 'monitor',
      component_id: 'service',
      config,
      interval: 600,
      enabled: 0,
      version: 1,
    })
    const end = now(),
      source = {
        lastUpdate: end,
        incident: {
          monitor: [
            { start: [end - 3600], end: end - 3600, error: ['dummy'] },
            { start: [end - 600], end: end - 300, error: ['HTTP 500'] },
          ],
        },
        latency: {
          monitor: Array.from({ length: 60 }, (_, i) => ({
            time: end - i * 60,
            ping: 20,
            loc: 'test',
          })),
        },
      }
    const prepared = prepareHistory(source, 'monitor')
    let offset = 0,
      first: any
    do {
      const payload = {
        format: 'prepared-v1',
        digest: prepared.digest,
        total: prepared.rows.length,
        offset,
        rows: prepared.rows.slice(offset, offset + 20),
      }
      const r = await call('/api/admin/monitors/monitor/import-history', 'POST', payload)
      if (!first) {
        first = payload
        const retry = await call('/api/admin/monitors/monitor/import-history', 'POST', first)
        expect(retry.nextOffset).toBe(r.nextOffset)
      }
      offset = r.nextOffset
    } while (offset < prepared.rows.length)
    expect(
      fixture.sqlite
        .prepare('SELECT sum(up_seconds) AS up,sum(down_seconds) AS down FROM daily_stats')
        .get()
    ).toMatchObject({ up: 3300, down: 300 })
    expect((await call('/api/admin/monitors/monitor/import-history', 'POST', first)).continue).toBe(
      false
    )
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM import_locks').get()!.n).toBe(0)
  })
  it('limits daily import writes and leaves the monitor resumable', async () => {
    await seed()
    await call('/api/admin/monitors/monitor', 'PUT', {
      name: 'monitor',
      component_id: 'service',
      config,
      interval: 600,
      enabled: 0,
      version: 1,
    })
    fixture.sqlite
      .prepare(
        'INSERT INTO free_usage(day,imports) VALUES (?,5000) ON CONFLICT(day) DO UPDATE SET imports=5000'
      )
      .run(Math.floor(now() / 86400))
    await expect(
      call('/api/admin/monitors/monitor/import-history', 'POST', {
        format: 'prepared-v1',
        digest: 'a'.repeat(64),
        total: 1,
        offset: 0,
        rows: [
          {
            kind: 'daily',
            day: Math.floor(now() / 86400) * 86400,
            up: 60,
            down: 0,
            latency: 20,
            samples: 1,
          },
        ],
      })
    ).rejects.toMatchObject({ status: 429 })
    expect(
      fixture.sqlite.prepare('SELECT cursor,lease_until FROM import_locks').get()
    ).toMatchObject({ cursor: 0, lease_until: 0 })
  })
  it('caches public responses but invalidates immediately on a visibility change', async () => {
    await seed()
    const stored = new Map<string, Response>(),
      waits: Promise<unknown>[] = []
    const cache = {
      match: async (r: Request) => stored.get(r.url)?.clone(),
      put: async (r: Request, v: Response) => {
        stored.set(r.url, v.clone())
      },
    } as unknown as Cache
    const get = async () => {
      const scope = invocationEnv(fixture.env)
      const r = await cachedApi(
        new Request('http://localhost/api/status'),
        scope.env,
        {
          waitUntil: (p) => {
            waits.push(p)
          },
        },
        cache
      )
      await Promise.all(waits)
      return { json: (await r.json()) as any, queries: scope.queryCount() }
    }
    expect((await get()).json.monitors).toHaveLength(1)
    expect((await get()).queries).toBe(1)
    await call('/api/admin/components/service', 'PUT', { name: 'hidden', public: 0, version: 1 })
    expect((await get()).json.monitors).toHaveLength(0)
  })
})
