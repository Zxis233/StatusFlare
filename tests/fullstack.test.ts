// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
vi.mock('../server/probe', () => ({ probe: vi.fn() }))
import { database } from './database'
import { api } from '../server/api'
import { publicData } from '../server/public'
import {
  monitorSchema,
  componentSchema,
  settingsSchema,
  channelConfigSchema,
} from '../server/validation'
import { db, now, seal, unseal } from '../server/core'
import { authorize } from '../server/auth'
import { schedule } from '../server/scheduler'
import { invocationEnv } from '../server/limits'
import { prepareHistory } from '../scripts/prepare-history.mjs'
import { deliver, enqueueNotification } from '../server/notifications'

let fixture: ReturnType<typeof database>
const good = { up: true, latency: 25, reason: '', location: 'test' }
const bad = { up: false, latency: 50, reason: 'HTTP 503', location: 'test' }
const config = {
  target: 'https://example.com/health',
  method: 'GET',
  timeout: 10000,
  headers: { Authorization: 'Bearer private-secret' },
  body: '',
  expectedCodes: [],
  responseKeyword: '',
  responseForbiddenKeyword: '',
  region: '',
  fallback: false,
}
async function call(path: string, method = 'GET', body?: unknown) {
  const scope = invocationEnv(fixture.env)
  try {
    return await api(
      new Request(`http://localhost/api/admin/${path}`, {
        method,
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }),
      scope.env
    )
  } finally {
    await scope.finish()
  }
}
async function seed(publicFlag = 1) {
  await call('components', 'POST', { id: 'service', name: 'Service', public: publicFlag })
  await call('monitors', 'POST', {
    id: 'monitor',
    name: 'Monitor',
    component_id: 'service',
    config,
    interval: 60,
    grace: 60,
  })
}
async function check(at: number, result = good) {
  vi.setSystemTime(at * 1000)
  const scope = invocationEnv(fixture.env)
  try {
    await schedule(scope.env, at, async () => result)
  } finally {
    await scope.finish()
  }
}
async function history() {
  return (
    await api(new Request('http://localhost/api/monitors/monitor/history'), fixture.env)
  ).json() as Promise<any>
}
function prepared(source: { lastUpdate: number; incident: unknown[]; latency: unknown[] }) {
  const result = prepareHistory(
    {
      lastUpdate: source.lastUpdate,
      incident: { monitor: source.incident },
      latency: { monitor: source.latency },
    },
    'monitor'
  )
  return {
    format: 'prepared-v1',
    digest: result.digest,
    total: result.rows.length,
    offset: 0,
    rows: result.rows,
  }
}
beforeEach(() => {
  fixture = database()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-16T12:00:00Z'))
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => new Response('ok'))
  )
})
afterEach(() => {
  fixture.sqlite.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('authentication, validation and privacy', () => {
  it.each(['invalid/channel', 'x'.repeat(81), 'invalid id', '通知渠道', '', 123, false, null, {}])(
    'rejects an invalid channel ID %j without creating a channel',
    async (id) => {
      await expect(
        call('channels', 'POST', {
          id,
          name: 'Invalid channel',
          config: { url: 'https://example.com/hook' },
        })
      ).rejects.toMatchObject({ name: 'ZodError' })
      expect(
        fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM notification_channels').get()
      ).toMatchObject({ count: 0 })
    }
  )
  it.each(['Hook_1-valid', 'x'.repeat(80), undefined])(
    'keeps a channel with ID %j accessible for reading, editing and deletion',
    async (requestedId) => {
      const response = await call('channels', 'POST', {
        ...(requestedId === undefined ? {} : { id: requestedId }),
        name: 'Valid channel',
        config: { url: 'https://example.com/hook' },
      })
      expect(response.status).toBe(201)
      const { id } = (await response.json()) as { id: string }
      expect(id).toMatch(/^[a-zA-Z0-9_-]{1,80}$/)
      if (requestedId !== undefined) expect(id).toBe(requestedId)
      expect(await (await call(`channels/${id}`)).json()).toMatchObject({
        id,
        name: 'Valid channel',
        version: 1,
      })
      expect(
        (
          await call(`channels/${id}`, 'PUT', {
            name: 'Updated channel',
            enabled: 0,
            version: 1,
          })
        ).status
      ).toBe(200)
      expect(await (await call(`channels/${id}`)).json()).toMatchObject({
        id,
        name: 'Updated channel',
        enabled: 0,
        version: 2,
      })
      expect((await call(`channels/${id}?version=2`, 'DELETE')).status).toBe(200)
      expect(
        fixture.sqlite.prepare('SELECT id FROM notification_channels WHERE id=?').get(id)
      ).toBeUndefined()
    }
  )
  it('allows five enabled channels, rejects a sixth and queues notifications for all five', async () => {
    for (let i = 1; i <= 5; i++) {
      expect(
        (
          await call('channels', 'POST', {
            id: `hook-${i}`,
            name: `Channel ${i}`,
            config: { url: `https://example.com/hook-${i}` },
          })
        ).status
      ).toBe(201)
    }
    await expect(
      call('channels', 'POST', {
        id: 'hook-6',
        name: 'Channel 6',
        config: { url: 'https://example.com/hook-6' },
      })
    ).rejects.toMatchObject({ status: 409, message: '最多同时启用 5 个通知渠道，请先停用其他渠道' })
    expect(
      fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM notification_channels').get()
    ).toMatchObject({ count: 5 })
    expect(
      (
        await call('channels/hook-5', 'PUT', {
          name: 'Updated channel',
          version: 1,
          config: { url: 'https://example.com/updated-hook' },
        })
      ).status
    ).toBe(200)
    await enqueueNotification(db(fixture.env), 'five-channel-test', 'Test message').run()
    expect(
      fixture.sqlite.prepare('SELECT channel_id FROM notification_outbox ORDER BY channel_id').all()
    ).toEqual(Array.from({ length: 5 }, (_, i) => ({ channel_id: `hook-${i + 1}` })))
  })
  it('keeps disabled channels outside the limit and checks capacity when enabling them', async () => {
    for (let i = 1; i <= 7; i++) {
      expect(
        (
          await call('channels', 'POST', {
            id: `hook-${i}`,
            name: `Channel ${i}`,
            enabled: i <= 5 ? 1 : 0,
            config: { url: `https://example.com/hook-${i}` },
          })
        ).status
      ).toBe(201)
    }
    expect(
      (
        await call('channels/hook-6', 'PUT', {
          name: 'Edited backup',
          enabled: 0,
          version: 1,
          config: { url: 'https://example.com/backup' },
        })
      ).status
    ).toBe(200)
    await expect(
      call('channels/hook-6', 'PUT', {
        name: 'Edited backup',
        enabled: 1,
        version: 2,
      })
    ).rejects.toMatchObject({ status: 409, message: '最多同时启用 5 个通知渠道，请先停用其他渠道' })
    expect(await (await call('channels/hook-6')).json()).toMatchObject({ enabled: 0, version: 2 })
    expect(
      (
        await call('channels/hook-1', 'PUT', {
          name: 'Channel 1',
          enabled: 0,
          version: 1,
        })
      ).status
    ).toBe(200)
    expect(
      (
        await call('channels/hook-6', 'PUT', {
          name: 'Edited backup',
          enabled: 1,
          version: 2,
        })
      ).status
    ).toBe(200)
    expect(
      fixture.sqlite
        .prepare('SELECT COUNT(*) AS count FROM notification_channels WHERE enabled=1')
        .get()
    ).toMatchObject({ count: 5 })
    expect(
      fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM notification_channels').get()
    ).toMatchObject({ count: 7 })
    await enqueueNotification(db(fixture.env), 'enabled-channel-test', 'Test message').run()
    expect(
      fixture.sqlite.prepare('SELECT channel_id FROM notification_outbox ORDER BY channel_id').all()
    ).toEqual([2, 3, 4, 5, 6].map((i) => ({ channel_id: `hook-${i}` })))
  })
  it('returns decrypted channel configuration only to authenticated administrators', async () => {
    await call('channels', 'POST', {
      id: 'editable-hook',
      name: 'Editable channel',
      config: {
        url: 'https://example.com/hook?key=channel-secret',
        headers: { Authorization: 'Bearer channel-secret' },
        payloadType: 'json',
        payload: { text: '$MSG' },
        timeout: 10000,
      },
    })
    const response = await call('channels/editable-hook')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const existing = (await response.json()) as any
    expect(existing).toMatchObject({
      id: 'editable-hook',
      name: 'Editable channel',
      enabled: 1,
      version: 1,
      config: {
        url: 'https://example.com/hook?key=channel-secret',
        headers: { Authorization: 'Bearer channel-secret' },
      },
    })
    const encrypted = fixture.sqlite
      .prepare('SELECT config FROM notification_channels WHERE id=?')
      .get('editable-hook') as any
    expect(encrypted.config).not.toContain('channel-secret')
    expect(JSON.stringify(await (await call('overview')).json())).not.toContain('channel-secret')
    await call('channels/editable-hook', 'PUT', {
      ...existing,
      config: { ...existing.config, timeout: 5000 },
    })
    const reopened = (await (await call('channels/editable-hook')).json()) as any
    expect(reopened.version).toBe(2)
    expect(reopened.config).toEqual({ ...existing.config, timeout: 5000 })
    await expect(
      api(new Request('http://localhost/api/admin/channels/editable-hook'), {
        ...fixture.env,
        ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
        ACCESS_AUD: 'test',
        ADMIN_EMAILS: 'admin@example.com',
      })
    ).rejects.toMatchObject({ status: 401 })
    await expect(call('channels/missing')).rejects.toMatchObject({ status: 404 })
  })
  it('keeps public links independent of probe targets', async () => {
    await seed()
    const existing = (await (await call('monitors/monitor')).json()) as any
    expect(existing.link).toBe('')
    await call('components/service', 'PUT', {
      name: 'Service',
      version: 1,
      link: 'https://example.com/',
    })
    expect(
      (
        await call('monitors/monitor', 'PUT', {
          ...existing,
          link: '  https://example.org/home  ',
        })
      ).status
    ).toBe(200)
    expect(
      (
        await call('monitors', 'POST', {
          id: 'tcp',
          name: 'TCP',
          component_id: 'service',
          config: { ...config, target: 'example.com:443', method: 'TCP_PING' },
          link: 'https://example.org/dashboard',
        })
      ).status
    ).toBe(201)
    const saved = (await (await call('monitors/monitor')).json()) as any
    expect(saved.link).toBe('https://example.org/home')
    expect(saved.config).toEqual(config)
    const overview = (await (await call('overview')).json()) as any
    expect(overview.monitors.find((m: any) => m.id === 'monitor').link).toBe(saved.link)
    const data = (await (
      await api(new Request('http://localhost/api/status'), fixture.env)
    ).json()) as any
    expect(data.components[0].link).toBe('https://example.com/')
    expect(data.monitors.find((m: any) => m.id === 'monitor').link).toBe(saved.link)
    expect(data.monitors.find((m: any) => m.id === 'tcp').link).toBe(
      'https://example.org/dashboard'
    )
    expect(JSON.stringify(data)).not.toContain(config.target)
    expect(JSON.stringify(data)).not.toContain('private-secret')
    await call('monitors/monitor', 'PUT', { ...saved, link: '' })
    expect((await publicData(fixture.env)).monitors.find((m) => m.id === 'monitor')!.link).toBe('')
    expect(((await (await call('monitors/monitor')).json()) as any).config).toEqual(config)
    await call('components/service', 'PUT', {
      name: 'Service',
      version: 2,
      public: 0,
      link: 'https://example.com/',
    })
    const hidden = await publicData(fixture.env)
    expect(hidden.components).toEqual([])
    expect(hidden.monitors).toEqual([])
  })
  it('validates optional service and monitor public URLs', () => {
    for (const link of ['', '   ', 'http://example.com', 'https://example.com/path?q=1#section']) {
      expect(
        monitorSchema.safeParse({ name: 'Monitor', component_id: 'service', config, link }).success
      ).toBe(true)
      expect(componentSchema.safeParse({ name: 'Service', link }).success).toBe(true)
    }
    for (const link of [
      'javascript:alert(1)',
      'data:text/html,test',
      '//example.com',
      '/relative',
      'ftp://example.com',
      'https://user:password@example.com',
      'http://localhost',
      'http://192.168.1.1',
      `https://example.com/${'a'.repeat(2000)}`,
    ]) {
      expect(
        monitorSchema.safeParse({ name: 'Monitor', component_id: 'service', config, link }).success
      ).toBe(false)
      expect(componentSchema.safeParse({ name: 'Service', link }).success).toBe(false)
    }
  })
  it('tests a saved disabled channel once and returns detailed administrator diagnostics', async () => {
    const config = channelConfigSchema.parse({
      url: 'https://example.com/private-token',
      payload: { text: '$MSG' },
    })
    await db(fixture.env)
      .prepare('INSERT INTO notification_channels(id,name,config,enabled) VALUES (?,?,?,0)')
      .bind('test-channel', 'Test', await seal(fixture.env, config))
      .run()
    const outbound = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }))
    const success = (await (await call('channels/test-channel/test', 'POST')).json()) as any
    expect(success).toMatchObject({ ok: true, elapsedMs: 0 })
    expect(success.log).toContain('HTTP 200')
    expect(outbound).toHaveBeenCalledTimes(1)
    expect(outbound.mock.calls[0][1]?.redirect).toBe('manual')
    expect(String(outbound.mock.calls[0][1]?.body)).toContain('测试通知')
    expect(String(outbound.mock.calls[0][1]?.body)).not.toContain('$MSG')
    outbound.mockResolvedValueOnce(
      new Response('{"ok":false,"description":"Unauthorized"}', { status: 401 })
    )
    const failure = (await (await call('channels/test-channel/test', 'POST')).json()) as any
    expect(failure).toMatchObject({ ok: false })
    expect(failure.log).toContain('HTTP 401')
    expect(failure.log).toContain('"description":"Unauthorized"')
    outbound.mockRejectedValueOnce(new DOMException('private-token', 'TimeoutError'))
    expect(
      ((await (await call('channels/test-channel/test', 'POST')).json()) as any).log
    ).toContain('超时')
    outbound.mockRejectedValueOnce(new Error('https://example.com/private-token'))
    const network = await (await call('channels/test-channel/test', 'POST')).json()
    expect(JSON.stringify(network)).toContain('https://example.com/private-token')
    expect(outbound).toHaveBeenCalledTimes(4)
    outbound.mockResolvedValueOnce(new Response('x'.repeat(20000), { status: 502 }))
    const oversized = (await (await call('channels/test-channel/test', 'POST')).json()) as any
    expect(oversized.log).toContain('HTTP 502')
    expect(oversized.log).toContain('已截断')
    expect(oversized.log.length).toBeLessThan(17000)
    outbound.mockResolvedValueOnce(
      new Response('Moved', {
        status: 302,
        headers: { location: 'https://other.example.com/' },
      })
    )
    const redirected = (await (await call('channels/test-channel/test', 'POST')).json()) as any
    expect(redirected).toMatchObject({ ok: false })
    expect(redirected.log).toContain('HTTP 302')
    expect(outbound).toHaveBeenCalledTimes(6)
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()!.n).toBe(0)
    await expect(call('channels/missing/test', 'POST')).rejects.toMatchObject({ status: 404 })
  })
  it('saves public background settings and supports clearing the image', async () => {
    for (const backgroundDim of [0, 0.6, 1]) {
      const settings = {
        title: 'Status',
        description: '',
        backgroundImageUrl: 'https://images.example.com/bg.jpg',
        backgroundDim,
      }
      expect((await call('settings', 'PUT', settings)).status).toBe(200)
      const response = await api(new Request('http://localhost/api/status'), fixture.env)
      expect(((await response.json()) as any).settings).toEqual(settings)
    }
    await call('settings', 'PUT', { title: 'Status', backgroundImageUrl: '', backgroundDim: 0.6 })
    expect((await publicData(fixture.env)).settings.backgroundImageUrl).toBe('')
    expect(settingsSchema.parse({ title: 'Old settings' })).toMatchObject({
      backgroundImageUrl: '',
      backgroundDim: 0.6,
    })
    for (const backgroundDim of [-0.1, 1.1, '0.5', null])
      expect(settingsSchema.safeParse({ title: 'Status', backgroundDim }).success).toBe(false)
    for (const backgroundImageUrl of [
      'http://example.com/a.jpg',
      'javascript:alert(1)',
      'https://user:password@example.com/a.jpg',
      'invalid',
    ])
      expect(settingsSchema.safeParse({ title: 'Status', backgroundImageUrl }).success).toBe(false)
  })
  it('returns only probe summaries in the admin overview', async () => {
    await seed()
    const overview = (await (await call('overview')).json()) as any
    const monitor = overview.monitors[0]
    expect(monitor.probeSummary).toEqual({ method: config.method, target: config.target })
    expect(monitor).not.toHaveProperty('config')
    expect(JSON.stringify(overview)).not.toContain('private-secret')
    const detail = (await (await call('monitors/monitor')).json()) as any
    expect(detail.config).toEqual(config)
  })
  it('exposes the last result version and latency so old readings are distinguishable after editing', async () => {
    await seed()
    const initial = (await (await call('overview')).json()) as any
    expect(initial.monitors[0]).toMatchObject({
      version: 1,
      result_version: null,
      latency: null,
      status: null,
    })
    await check(now())
    const checked = (await (await call('overview')).json()) as any
    expect(checked.monitors[0]).toMatchObject({
      version: 1,
      result_version: 1,
      status: 'up',
      latency: 25,
      checked_at: now(),
    })
    await call('monitors/monitor', 'PUT', {
      name: 'Updated',
      component_id: 'service',
      config,
      version: 1,
    })
    const edited = (await (await call('overview')).json()) as any
    expect(edited.monitors[0]).toMatchObject({
      version: 2,
      result_version: 1,
      status: 'up',
      latency: 25,
    })
  })
  it('persists monitor order for admin and public lists with stable ties', async () => {
    await seed()
    for (const [id, position] of [
      ['z-first', 10],
      ['a-second', 20],
      ['b-second', 20],
    ] as const) {
      const response = await call('monitors', 'POST', {
        id,
        name: id,
        component_id: 'service',
        config,
        position,
      })
      expect(response.status).toBe(201)
    }
    const existing = (await (await call('monitors/monitor')).json()) as any
    expect(existing.position).toBe(0)
    const response = await call('monitors/monitor', 'PUT', { ...existing, position: 30 })
    expect(response.status).toBe(200)
    expect(((await (await call('monitors/monitor')).json()) as any).position).toBe(30)
    const expected = ['z-first', 'a-second', 'b-second', 'monitor']
    const result = await publicData(fixture.env)
    expect(result.monitors.map((m) => m.id)).toEqual(expected)
    const overview = (await (await call('overview')).json()) as any
    expect(overview.monitors.map((m: any) => m.id)).toEqual(expected)
    for (const position of [-1, 1.5, 2147483648])
      expect(monitorSchema.safeParse({ ...existing, position }).success).toBe(false)
  })
  it('fails closed without identity configuration and forbids a forged email header', async () => {
    await expect(
      authorize(
        new Request('https://status.example/api/admin/me', {
          headers: { 'cf-access-authenticated-user-email': 'admin@example.com' },
        }),
        { ...fixture.env, ENVIRONMENT: 'production' }
      )
    ).rejects.toMatchObject({ status: 503 })
    await expect(
      authorize(
        new Request('https://status.example/api/admin/me', {
          headers: { authorization: 'Bearer test-token' },
        }),
        fixture.env
      )
    ).rejects.toMatchObject({ status: 503 })
  })
  it('rejects cross-origin management writes', async () => {
    await expect(
      authorize(
        new Request('http://localhost/api/admin/groups', {
          method: 'POST',
          headers: { origin: 'https://evil.example', authorization: 'Bearer test-token' },
        }),
        fixture.env
      )
    ).rejects.toMatchObject({ status: 403 })
  })
  it('encrypts secrets and rejects decryption with a different key', async () => {
    const encrypted = await seal(fixture.env, config)
    expect(encrypted).not.toContain('private-secret')
    expect(await unseal(fixture.env, encrypted)).toEqual(config)
    await expect(
      unseal({ ...fixture.env, ENCRYPTION_KEY: btoa('b'.repeat(32)) }, encrypted)
    ).rejects.toThrow()
  })
  it('rejects private targets, invalid response codes, and HEAD keyword checks', () => {
    for (const target of ['example.com:80', 'example.com:443'])
      expect(
        monitorSchema.safeParse({
          name: 'tcp',
          component_id: 'service',
          config: { ...config, target, method: 'TCP_PING' },
        }).success
      ).toBe(true)
    for (const target of [
      'http://127.0.0.1',
      'http://0x7f000001',
      'http://[::ffff:127.0.0.1]',
      'file:///etc/passwd',
    ])
      expect(
        monitorSchema.safeParse({
          name: 'x',
          component_id: 'service',
          config: { ...config, target },
        }).success
      ).toBe(false)
    expect(
      monitorSchema.safeParse({
        name: 'x',
        component_id: 'service',
        config: { ...config, method: 'HEAD', responseKeyword: 'ok' },
      }).success
    ).toBe(false)
  })
  it('never exposes target URLs or credentials and excludes private services', async () => {
    await seed()
    const response = await publicData(fixture.env)
    expect(JSON.stringify(response)).not.toMatch(/private-secret|example\.com|Authorization|config/)
    await call('components/service', 'PUT', {
      id: 'service',
      name: 'Service',
      public: 0,
      version: 1,
    })
    const hidden = await publicData(fixture.env)
    expect(hidden.components).toHaveLength(0)
    expect(hidden.monitors).toHaveLength(0)
    await expect(
      api(new Request('http://localhost/api/monitors/monitor/history'), fixture.env)
    ).rejects.toMatchObject({ status: 404 })
  })
})
describe('management and event lifecycle', () => {
  it('preserves the legacy data and badge API shapes without exposing private monitors', async () => {
    await seed()
    const data: any = await (
      await api(new Request('http://localhost/api/data'), fixture.env)
    ).json()
    expect(data.monitors.monitor.up).toBe(null)
    expect(data.monitors.monitor.message).toBe('unknown')
    const badge: any = await (
      await api(new Request('http://localhost/api/badge?id=monitor'), fixture.env)
    ).json()
    expect(badge.schemaVersion).toBe(1)
    expect(badge.message).toBe('UNKNOWN')
    await call('components/service', 'PUT', { name: 'Service', public: 0, version: 1 })
    expect(
      (await api(new Request('http://localhost/api/badge?id=monitor'), fixture.env)).status
    ).toBe(404)
  })
  it('rejects stale edits without losing newer configuration', async () => {
    await seed()
    const value = { name: 'Updated', component_id: 'service', config, version: 1 }
    await call('monitors/monitor', 'PUT', value)
    await expect(
      call('monitors/monitor', 'PUT', { ...value, name: 'Stale' })
    ).rejects.toMatchObject({ status: 409 })
    expect(fixture.sqlite.prepare('SELECT name FROM monitors').get()!.name).toBe('Updated')
  })
  it('keeps drafts private, appends progress, and creates durable notifications only on publish', async () => {
    await seed()
    await call('channels', 'POST', {
      id: 'event-hook',
      name: 'Channel',
      config: { url: 'https://example.com/hook', payloadType: 'json', payload: { text: '$MSG' } },
    })
    const event = {
      id: 'incident',
      kind: 'incident',
      title: 'API outage',
      status: 'investigating',
      start_at: now(),
      components: ['service'],
      notificationChannels: ['event-hook'],
      body: 'Investigating',
      published: 0,
    }
    await call('events', 'POST', event)
    expect((await publicData(fixture.env)).events).toHaveLength(0)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM notification_outbox').get()!.n).toBe(0)
    await call('events/incident', 'PUT', {
      ...event,
      published: 1,
      version: 1,
      body: 'Root cause found',
      status: 'identified',
    })
    const events = (await publicData(fixture.env)).events
    expect(events[0].updates).toHaveLength(1)
    expect(events[0].moreUpdates).toBe(true)
    expect(events[0].status).toBe('identified')
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM notification_outbox').get()!.n).toBe(1)
    await expect(
      call('events/incident', 'PUT', { ...event, published: 1, version: 1, body: 'Stale update' })
    ).rejects.toMatchObject({ status: 409 })
    expect((await publicData(fixture.env)).events[0].updates).toHaveLength(1)
    const updates = (await (
      await api(new Request('http://localhost/api/incidents/incident/updates'), fixture.env)
    ).json()) as any
    expect(updates.updates).toHaveLength(2)
  })
  it.each([
    ['incident', 'investigating'],
    ['maintenance', 'scheduled'],
  ])('sends %s notifications only to channels selected for this save', async (kind, status) => {
    await seed()
    for (const [id, enabled] of [
      ['one', 1],
      ['two', 1],
      ['other', 1],
      ['disabled', 0],
    ] as const)
      await call('channels', 'POST', {
        id,
        name: id,
        enabled,
        config: { url: `https://example.com/${id}` },
      })
    const event = {
      id: 'event',
      kind,
      status,
      title: 'Notice',
      start_at: now(),
      components: ['service'],
      body: 'Progress',
      published: 1,
    }
    await call('events', 'POST', event)
    expect(fixture.sqlite.prepare('SELECT id FROM notification_outbox').all()).toHaveLength(0)
    await call('events/event', 'PUT', {
      ...event,
      version: 1,
      notificationChannels: ['one', 'two', 'one'],
    })
    expect(
      fixture.sqlite.prepare('SELECT channel_id FROM notification_outbox ORDER BY channel_id').all()
    ).toEqual([{ channel_id: 'one' }, { channel_id: 'two' }])
    await call('events/event', 'PUT', { ...event, version: 2 })
    expect(fixture.sqlite.prepare('SELECT id FROM notification_outbox').all()).toHaveLength(2)
    for (const channel of ['disabled', 'missing'])
      await expect(
        call('events/event', 'PUT', { ...event, version: 3, notificationChannels: [channel] })
      ).rejects.toMatchObject({ status: 400 })
    await expect(
      call('events/event', 'PUT', { ...event, version: 1, notificationChannels: ['other'] })
    ).rejects.toMatchObject({ status: 409 })
    expect(fixture.sqlite.prepare('SELECT id FROM notification_outbox').all()).toHaveLength(2)
    await call('events/event', 'PUT', {
      ...event,
      version: 3,
      published: 0,
      notificationChannels: ['other'],
    })
    expect(fixture.sqlite.prepare('SELECT id FROM notification_outbox').all()).toHaveLength(2)
    await call('events/event', 'PUT', { ...event, version: 4, notificationChannels: ['other'] })
    expect(
      fixture.sqlite.prepare('SELECT channel_id FROM notification_outbox ORDER BY channel_id').all()
    ).toEqual([{ channel_id: 'one' }, { channel_id: 'other' }, { channel_id: 'two' }])
    const overview = (await (await call('overview')).json()) as any
    expect(overview.events[0]).not.toHaveProperty('notificationChannels')
    expect((await publicData(fixture.env)).events[0]).not.toHaveProperty('notificationChannels')
  })
  it('rejects public announcements linked to private services', async () => {
    await seed(0)
    await expect(
      call('events', 'POST', {
        kind: 'incident',
        title: 'Private',
        status: 'investigating',
        start_at: now(),
        components: ['service'],
        body: 'secret',
        published: 1,
      })
    ).rejects.toMatchObject({ status: 400 })
  })
})
describe('monitoring correctness', () => {
  it('deduplicates batches and records a failure/recovery interval with a grace period', async () => {
    await seed()
    await call('channels', 'POST', { name: 'Channel', config: { url: 'https://example.com/hook' } })
    const start = now()
    await check(start, good)
    await check(start + 60, bad)
    await check(start + 60, bad)
    expect((await history()).samples).toHaveLength(2)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM notification_outbox').get()!.n).toBe(0)
    await check(start + 120, bad)
    await check(start + 180, good)
    const stats = (await history()).daily[0]
    expect(stats.up_seconds).toBe(60)
    expect(stats.down_seconds).toBe(120)
    expect(
      fixture.sqlite.prepare('SELECT end_at-start_at AS duration FROM monitor_outages').get()!
        .duration
    ).toBe(120)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM notification_outbox').get()!.n).toBe(2)
  })
  it('discards results if the monitor changes while its request is in flight', async () => {
    await seed()
    await schedule(fixture.env, now(), async () => {
      await call('monitors/monitor', 'PUT', {
        name: 'New',
        component_id: 'service',
        config,
        version: 1,
      })
      return bad
    })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM current_monitor_state').get()!.n).toBe(
      0
    )
  })
  it('does not count a long scheduler gap as fully observed uptime', async () => {
    await seed()
    const t = now()
    await check(t)
    vi.setSystemTime((t + 300) * 1000)
    expect((await publicData(fixture.env)).monitors[0].status).toBe('unknown')
    await check(t + 600)
    expect((await history()).daily[0].up_seconds).toBe(120)
  })
  it('does not close a manual incident when checks recover', async () => {
    await seed()
    await call('events', 'POST', {
      id: 'manual',
      kind: 'incident',
      title: 'Manual',
      status: 'monitoring',
      start_at: now(),
      components: ['service'],
      body: 'Observing',
      published: 1,
    })
    await check(now())
    expect(fixture.sqlite.prepare('SELECT status FROM events').get()!.status).toBe('monitoring')
  })
  it('silences automatic notifications during scheduled maintenance but retains checks', async () => {
    await seed()
    await call('events', 'POST', {
      kind: 'maintenance',
      title: 'Maintenance',
      status: 'scheduled',
      start_at: now() - 60,
      end_at: now() + 600,
      components: ['service'],
      body: 'Planned work',
      published: 1,
    })
    await call('channels', 'POST', { name: 'Channel', config: { url: 'https://example.com/hook' } })
    const t = now()
    await check(t, bad)
    await check(t + 60, bad)
    expect((await history()).samples).toHaveLength(2)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM notification_outbox').get()!.n).toBe(0)
  })
})
describe('migration and delivery', () => {
  it('resumes large history imports over multiple bounded requests', async () => {
    await seed()
    await call('monitors/monitor', 'PUT', {
      name: 'Monitor',
      component_id: 'service',
      config,
      enabled: 0,
      version: 1,
    })
    const end = now(),
      history = {
        lastUpdate: end,
        incident: [{ start: [end - 43200], end: end - 43200, error: ['dummy'] }],
        latency: Array.from({ length: 720 }, (_, i) => ({
          time: end - (719 - i) * 60,
          ping: 20,
          loc: 'legacy',
        })),
      }
    const payload = prepared(history)
    const first = (await (
      await call('monitors/monitor/import-history', 'POST', {
        ...payload,
        rows: payload.rows.slice(0, 20),
      })
    ).json()) as any
    expect(first).toMatchObject({ continue: true })
    await expect(
      call('monitors/monitor', 'PUT', {
        name: 'Monitor',
        component_id: 'service',
        config,
        enabled: 1,
        version: 2,
      })
    ).rejects.toThrow('history import in progress')
    let progress = first
    while (progress.continue) {
      const offset = progress.nextOffset
      progress = await (
        await call('monitors/monitor/import-history', 'POST', {
          ...payload,
          offset,
          rows: payload.rows.slice(offset, offset + 20),
        })
      ).json()
    }
    expect(progress.imported).toBe(true)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM import_locks').get()!.n).toBe(0)
    expect(fixture.sqlite.prepare('SELECT sum(up_seconds) AS n FROM daily_stats').get()!.n).toBe(
      43200
    )
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM check_results').get()!.n).toBe(720)
  })
  it('blocks enabling a monitor while its history import owns the lock', async () => {
    await seed()
    await call('monitors/monitor', 'PUT', {
      name: 'Monitor',
      component_id: 'service',
      config,
      enabled: 0,
      version: 1,
    })
    fixture.sqlite
      .prepare(
        'INSERT INTO import_locks(monitor_id,token,lease_until,payload_hash) VALUES (?,?,?,?)'
      )
      .run('monitor', 'owner', now() + 120, 'hash')
    await expect(
      call('monitors/monitor', 'PUT', {
        name: 'Monitor',
        component_id: 'service',
        config,
        enabled: 1,
        version: 2,
      })
    ).rejects.toThrow('history import in progress')
    await expect(
      call(
        'monitors/monitor/import-history',
        'POST',
        prepared({ lastUpdate: now(), incident: [], latency: [] })
      )
    ).rejects.toMatchObject({ status: 409 })
  })
  it('retains attachment associations when appending a new incident update', async () => {
    await seed()
    fixture.sqlite
      .prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?)')
      .run('file', 'attachments/file', 'test.png', 'image/png', 10, now())
    const event = {
      id: 'attachment-event',
      kind: 'incident',
      title: 'Incident',
      status: 'investigating',
      start_at: now(),
      components: ['service'],
      body: '![image](/attachments/file)',
      attachments: ['file'],
      published: 1,
    }
    await call('events', 'POST', event)
    await call('events/attachment-event', 'PUT', {
      ...event,
      body: 'More information',
      attachments: [],
      version: 1,
    })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM event_attachments').get()!.n).toBe(1)
  })
  it('paginates incidents with equal start times without losing a record', async () => {
    await seed()
    for (let i = 0; i < 21; i++) {
      const id = `incident-${String(i).padStart(3, '0')}`
      fixture.sqlite
        .prepare(
          'INSERT INTO events(id,kind,title,status,severity,start_at,published,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
        )
        .run(id, 'incident', 'Incident', 'resolved', 'minor', now() - 100, 1, now(), now())
      fixture.sqlite.prepare('INSERT INTO event_components VALUES (?,?)').run(id, 'service')
    }
    const first: any = await (
      await api(new Request('http://localhost/api/incidents'), fixture.env)
    ).json()
    const second: any = await (
      await api(
        new Request(`http://localhost/api/incidents?cursor=${first.nextCursor}`),
        fixture.env
      )
    ).json()
    expect(first.events).toHaveLength(20)
    expect(second.events).toHaveLength(1)
    expect(new Set([...first.events, ...second.events].map((e) => e.id)).size).toBe(21)
  })
  it('reclaims an expired batch lease and respects long monitor intervals', async () => {
    await seed()
    const t = now()
    fixture.sqlite.prepare('UPDATE monitors SET interval=86400').run()
    fixture.sqlite
      .prepare('UPDATE free_runtime SET token=?,lease_until=?,slot=? WHERE id=1')
      .run('old-owner', t - 1, Math.floor(t / 60) - 1)
    await check(t)
    expect(
      fixture.sqlite.prepare('SELECT status,checked_at FROM current_monitor_state').get()
    ).toMatchObject({ status: 'up', checked_at: t })
    expect(
      fixture.sqlite.prepare('SELECT token,lease_until FROM free_runtime').get()
    ).toMatchObject({ token: null, lease_until: 0 })
    await check(t + 60)
    expect((await history()).samples).toHaveLength(1)
    await check(t + 86400)
    expect(
      fixture.sqlite.prepare('SELECT checked_at FROM current_monitor_state').get()!.checked_at
    ).toBe(t + 86400)
  })
  it('imports old history idempotently without deleting the original state', async () => {
    await seed()
    await call('monitors/monitor', 'PUT', {
      name: 'Monitor',
      component_id: 'service',
      config,
      enabled: 0,
      version: 1,
    })
    const t = now()
    fixture.sqlite.prepare("INSERT INTO uptimeflare VALUES ('state','original')").run()
    const history = {
      lastUpdate: t,
      incident: [
        { start: [t - 3600], end: t - 3600, error: ['dummy'] },
        { start: [t - 600], end: t - 300, error: ['HTTP 500'] },
      ],
      latency: [],
    }
    await call('monitors/monitor/import-history', 'POST', prepared(history))
    await call('monitors/monitor/import-history', 'POST', prepared(history))
    const stats = fixture.sqlite.prepare('SELECT * FROM daily_stats').get()!
    expect(stats.up_seconds).toBe(3300)
    expect(stats.down_seconds).toBe(300)
    expect(fixture.sqlite.prepare('SELECT value FROM uptimeflare').get()!.value).toBe('original')
  })
  it('retries failed webhook delivery without leaking provider response or secrets', async () => {
    await call('channels', 'POST', {
      id: 'channel',
      name: 'Channel',
      config: { url: 'https://example.com/secret-token' },
    })
    fixture.sqlite
      .prepare(
        'INSERT INTO notification_outbox(id,channel_id,message,available_at,created_at) VALUES (?,?,?,?,?)'
      )
      .run('message', 'channel', 'hello', now(), now())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret-token', { status: 500 })))
    await deliver(fixture.env, 'message')
    const row = fixture.sqlite.prepare('SELECT * FROM notification_outbox').get()!
    expect(row.state).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.error).not.toContain('secret-token')
    vi.unstubAllGlobals()
  })
})
