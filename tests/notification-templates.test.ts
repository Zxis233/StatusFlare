import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../server/probe', () => ({ probe: vi.fn() }))
import { database } from './database'
import { api } from '../server/api'
import { schedule } from '../server/scheduler'
import { invocationEnv } from '../server/limits'
import { notificationTemplatesSchema } from '../server/validation'
import {
  defaultNotificationTemplates,
  renderNotificationTemplate,
  formatNotificationTime,
} from '../shared/notification-templates'

let fixture: ReturnType<typeof database>
beforeEach(() => {
  fixture = database()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-22T08:00:00Z'))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('ok'))
  )
})
afterEach(() => {
  fixture.sqlite.close()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function call(path: string, method = 'GET', value?: unknown) {
  const scope = invocationEnv(fixture.env)
  try {
    const response = await api(
      new Request(`http://localhost/api/admin/${path}`, {
        method,
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: value === undefined ? undefined : JSON.stringify(value),
      }),
      scope.env
    )
    return (await response.json()) as any
  } finally {
    await scope.finish()
    expect(scope.queryCount()).toBeLessThanOrEqual(50)
  }
}
const custom = {
  timeZone: 'UTC',
  down: '异常：{{monitorName}} / {{reason}} / {{time}}',
  recovery: '恢复：{{monitorName}} / {{time}}',
  event: '公告：{{title}} / {{status}} / {{body}} / {{time}}',
}
async function seed() {
  await call('components', 'POST', { id: 'service', name: 'Service' })
  await call('channels', 'POST', {
    id: 'hook',
    name: 'Webhook',
    config: { url: 'https://example.com/hook' },
  })
}
it('accepts the empty POST streams sent by real local Worker channel tests', async () => {
  const channel = await call('channels', 'POST', {
    name: 'Test',
    config: { url: 'https://example.com/hook' },
  })
  const response = await api(
    new Request(`http://localhost/api/admin/channels/${channel.id}/test`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: '',
    }),
    fixture.env
  )
  expect(await response.json()).toMatchObject({ ok: true })
  expect(fetch).toHaveBeenCalledTimes(1)
})
it.each([
  ['down', '异常：网站首页'],
  ['recovery', '恢复：网站首页'],
  ['incident', '故障事件 / 调查中'],
  ['maintenance', '计划维护 / 已计划'],
])(
  'sends an unsaved %s template once through a disabled saved channel',
  async (scenario, expected) => {
    const channel = await call('channels', 'POST', {
      name: 'Test',
      enabled: 0,
      config: { url: 'https://example.com/hook', payload: { content: '$MSG' } },
    })
    const templates = {
      ...custom,
      timeZone: 'Asia/Shanghai',
      event: '{{kind}} / {{status}} / {{services}} / {{severity}} / {{startTime}} / {{endTime}}',
    }
    const result = await call(`channels/${channel.id}/test`, 'POST', { scenario, templates })
    expect(result.ok).toBe(true)
    expect(result.log).toContain('HTTP 200')
    expect(fetch).toHaveBeenCalledTimes(1)
    const content = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).content
    expect(content).toContain('[测试通知]')
    expect(content).toContain(expected)
    expect(content).toContain('2026-09-22 16:00:00 UTC+08:00')
    if (scenario === 'maintenance') expect(content).toContain('2026-09-22 17:00:00 UTC+08:00')
    if (scenario === 'incident') expect(content).toContain('待定')
    expect((await call('overview')).notificationTemplates).toEqual(defaultNotificationTemplates)
    expect(fixture.sqlite.prepare('SELECT id FROM notification_outbox').all()).toHaveLength(0)
    expect(fixture.sqlite.prepare('SELECT id FROM events').all()).toHaveLength(0)
    expect(
      fixture.sqlite
        .prepare("SELECT action FROM audit_logs WHERE action='channel.template-test'")
        .all()
    ).toHaveLength(1)
  }
)
it('validates template tests and reports send failures without retrying', async () => {
  const channel = await call('channels', 'POST', {
    name: 'Test',
    config: { url: 'https://example.com/hook' },
  })
  const path = `channels/${channel.id}/test`
  for (const value of [
    { scenario: 'invalid', templates: custom },
    { scenario: 'down', templates: { ...custom, down: '{{bad}}' } },
    { scenario: 'down', templates: { ...custom, timeZone: 'Invalid/Zone' } },
  ])
    await expect(call(path, 'POST', value)).rejects.toThrow()
  await expect(
    call('channels/missing/test', 'POST', { scenario: 'down', templates: custom })
  ).rejects.toMatchObject({ status: 404 })
  expect(fetch).not.toHaveBeenCalled()
  vi.mocked(fetch).mockResolvedValueOnce(new Response('Rejected', { status: 400 }))
  const result = await call(path, 'POST', { scenario: 'down', templates: custom })
  expect(result.ok).toBe(false)
  expect(result.log).toContain('HTTP 400')
  expect(result.log).toContain('Rejected')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fixture.sqlite.prepare('SELECT id FROM notification_outbox').all()).toHaveLength(0)
})
it('loads defaults, saves private templates separately and restores defaults', async () => {
  expect((await call('overview')).notificationTemplates).toEqual(defaultNotificationTemplates)
  expect(await call('settings/notification-templates', 'PUT', custom)).toEqual(custom)
  await call('settings', 'PUT', { title: 'Page' })
  expect((await call('overview')).notificationTemplates).toEqual(custom)
  const response = await api(new Request('http://localhost/api/status'), fixture.env)
  expect(JSON.stringify(await response.json())).not.toContain('异常：')
  await call('settings/notification-templates', 'PUT', defaultNotificationTemplates)
  expect((await call('overview')).notificationTemplates).toEqual(defaultNotificationTemplates)
})
it('keeps old saved templates compatible and rejects invalid time zones', async () => {
  const { timeZone, ...legacy } = custom
  fixture.sqlite
    .prepare("INSERT INTO settings(key,value) VALUES ('notification_templates',?)")
    .run(JSON.stringify(legacy))
  expect((await call('overview')).notificationTemplates.timeZone).toBe('UTC')
  expect((await call('settings/notification-templates', 'PUT', legacy)).timeZone).toBe('UTC')
  for (const zone of ['', 'Mars/Olympus', '+08:00']) {
    await expect(
      call('settings/notification-templates', 'PUT', { ...custom, timeZone: zone })
    ).rejects.toThrow()
  }
})
it('formats cross-day and daylight-saving times independently of the host time zone', () => {
  expect(formatNotificationTime(Date.parse('2026-09-22T20:30:00Z') / 1000, 'Asia/Shanghai')).toBe(
    '2026-09-23 04:30:00 UTC+08:00'
  )
  expect(
    formatNotificationTime(Date.parse('2026-01-22T08:00:00Z') / 1000, 'America/New_York')
  ).toBe('2026-01-22 03:00:00 UTC-05:00')
  expect(
    formatNotificationTime(Date.parse('2026-07-22T08:00:00Z') / 1000, 'America/New_York')
  ).toBe('2026-07-22 04:00:00 UTC-04:00')
})
it('applies the saved time zone to monitor notifications and every announcement time variable', async () => {
  await seed()
  await call('settings/notification-templates', 'PUT', {
    ...custom,
    timeZone: 'Asia/Shanghai',
    event: '{{time}}\n{{startTime}}\n{{endTime}}',
  })
  await call('monitors', 'POST', {
    id: 'monitor',
    name: 'Website',
    component_id: 'service',
    interval: 60,
    grace: 0,
    config: { target: 'https://example.com' },
  })
  const t = Date.now() / 1000
  await schedule(fixture.env, t, async () => ({
    up: false,
    latency: 20,
    reason: 'HTTP 503',
    location: 'test',
  }))
  expect(
    vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(init!.body as string).text)
  ).toContain('异常：Website / HTTP 503 / 2026-09-22 16:00:00 UTC+08:00')
  await call('events', 'POST', {
    id: 'incident',
    kind: 'incident',
    title: 'Issue',
    status: 'investigating',
    start_at: t,
    end_at: t + 3600,
    published: 1,
    components: ['service'],
    notificationChannels: ['hook'],
    body: 'Progress',
  })
  expect(
    fixture.sqlite.prepare("SELECT message FROM notification_outbox WHERE id LIKE 'event:%'").get()!
      .message
  ).toBe(
    '2026-09-22 16:00:00 UTC+08:00\n2026-09-22 16:00:00 UTC+08:00\n2026-09-22 17:00:00 UTC+08:00'
  )
})
it('rejects invalid templates without changing saved settings and requires authentication', async () => {
  await call('settings/notification-templates', 'PUT', custom)
  for (const down of ['', '   ', '{{title}}', '{{constructor}}', '{{time', 'x'.repeat(4001)]) {
    expect(notificationTemplatesSchema.safeParse({ ...custom, down }).success).toBe(false)
    await expect(
      call('settings/notification-templates', 'PUT', { ...custom, down })
    ).rejects.toThrow()
  }
  expect((await call('overview')).notificationTemplates).toEqual(custom)
  Object.assign(fixture.env, {
    ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
    ACCESS_AUD: 'test-audience',
    ADMIN_EMAILS: 'admin@example.com',
  })
  await expect(
    api(
      new Request('http://localhost/api/admin/settings/notification-templates', {
        method: 'PUT',
        body: JSON.stringify(custom),
      }),
      fixture.env
    )
  ).rejects.toMatchObject({ status: 401 })
})
it('renders values literally in one pass, including replacement metacharacters and placeholders', () => {
  expect(
    renderNotificationTemplate('{{title}}\n{{body}}\n{{ title }}', {
      title: '$& {{body}}',
      body: 'literal "quoted"\ntext',
    })
  ).toBe('$& {{body}}\nliteral "quoted"\ntext\n$& {{body}}')
})
it('uses saved templates for actual down and recovery webhook payloads', async () => {
  await seed()
  await call('settings/notification-templates', 'PUT', custom)
  await call('monitors', 'POST', {
    id: 'monitor',
    name: 'Website',
    component_id: 'service',
    interval: 60,
    grace: 0,
    config: { target: 'https://example.com' },
  })
  const start = Math.floor(Date.now() / 1000)
  for (const [offset, up] of [
    [0, false],
    [60, true],
  ] as const) {
    vi.setSystemTime((start + offset) * 1000)
    const scope = invocationEnv(fixture.env)
    await schedule(scope.env, start + offset, async () => ({
      up,
      latency: 20,
      reason: up ? '' : 'HTTP 503',
      location: 'test',
    }))
    await scope.finish()
    expect(scope.queryCount()).toBeLessThanOrEqual(50)
  }
  const messages = vi
    .mocked(fetch)
    .mock.calls.map(([, init]) => JSON.parse(init!.body as string).text)
  expect(messages).toEqual([
    '异常：Website / HTTP 503 / 2026-09-22T08:00:00.000Z',
    '恢复：Website / 2026-09-22T08:01:00.000Z',
  ])
})
it('formats published announcements and updates at enqueue time without changing queued messages', async () => {
  await seed()
  await call('settings/notification-templates', 'PUT', custom)
  const event = {
    id: 'incident',
    kind: 'incident',
    title: 'Issue',
    status: 'investigating',
    start_at: 1,
    published: 0,
    components: ['service'],
    notificationChannels: ['hook'],
    body: 'Draft',
  }
  await call('events', 'POST', event)
  expect(fixture.sqlite.prepare('SELECT message FROM notification_outbox').all()).toHaveLength(0)
  await call('events/incident', 'PUT', {
    ...event,
    published: 1,
    version: 1,
    body: 'First {{title}}',
  })
  await call('settings/notification-templates', 'PUT', { ...custom, event: 'Update: {{body}}' })
  await call('events/incident', 'PUT', { ...event, published: 1, version: 2, body: 'Second' })
  const messages = fixture.sqlite
    .prepare('SELECT message FROM notification_outbox ORDER BY id')
    .all()
    .map((row) => row.message)
  expect(messages).toEqual([
    '公告：Issue / 调查中 / First {{title}} / 2026-09-22T08:00:00.000Z',
    'Update: Second',
  ])
})
it('renders announcement schedule variables on publish and update, with an unset end time', async () => {
  await seed()
  await call('settings/notification-templates', 'PUT', {
    ...custom,
    event: '{{status}}\n预计开始：{{startTime}}\n预计结束：{{endTime}}',
  })
  const event = {
    id: 'maintenance',
    kind: 'maintenance',
    title: '维护',
    status: 'scheduled',
    start_at: Date.parse('2026-09-23T01:00:00Z') / 1000,
    published: 1,
    components: ['service'],
    notificationChannels: ['hook'],
    body: '维护计划',
  }
  await call('events', 'POST', event)
  await call('events/maintenance', 'PUT', {
    ...event,
    version: 1,
    end_at: Date.parse('2026-09-23T02:00:00Z') / 1000,
  })
  await call('events/maintenance', 'PUT', { ...event, version: 2, end_at: null })
  const messages = fixture.sqlite
    .prepare('SELECT message FROM notification_outbox ORDER BY id')
    .all()
    .map((row) => row.message)
  expect(messages).toEqual([
    '已计划\n预计开始：2026-09-23T01:00:00.000Z\n预计结束：待定',
    '已计划\n预计开始：2026-09-23T01:00:00.000Z\n预计结束：2026-09-23T02:00:00.000Z',
    '已计划\n预计开始：2026-09-23T01:00:00.000Z\n预计结束：待定',
  ])
})
it('renders Chinese severity on announcement creation and subsequent updates', async () => {
  await seed()
  await call('settings/notification-templates', 'PUT', {
    ...custom,
    event: '{{status}} / {{severity}}',
  })
  const event = {
    id: 'incident',
    kind: 'incident',
    title: 'Issue',
    status: 'investigating',
    start_at: 1,
    published: 1,
    components: ['service'],
    notificationChannels: ['hook'],
    body: 'Progress',
  }
  await call('events', 'POST', event)
  await call('events/incident', 'PUT', { ...event, version: 1, severity: 'major' })
  await call('events/incident', 'PUT', { ...event, version: 2, severity: 'critical' })
  expect(
    fixture.sqlite
      .prepare('SELECT message FROM notification_outbox ORDER BY id')
      .all()
      .map((row) => row.message)
  ).toEqual(['调查中 / 轻微影响', '调查中 / 主要故障', '调查中 / 严重故障'])
})
it('renders selected service names in order on publish and update without changing queued messages', async () => {
  await seed()
  await call('components', 'POST', { id: 'payments', name: '支付服务' })
  await call('components', 'POST', { id: 'private', name: '私有服务', public: 0 })
  await call('settings/notification-templates', 'PUT', {
    ...custom,
    event: '受影响服务：{{services}}',
  })
  const event = {
    id: 'incident',
    kind: 'incident',
    title: 'Issue',
    status: 'investigating',
    start_at: 1,
    published: 1,
    components: ['payments', 'service', 'payments'],
    notificationChannels: ['hook'],
    body: 'Progress',
  }
  await call('events', 'POST', event)
  await call('events/incident', 'PUT', { ...event, version: 1, components: ['service'] })
  await expect(
    call('events/incident', 'PUT', { ...event, version: 2, components: ['private'] })
  ).rejects.toMatchObject({ status: 400 })
  expect(
    fixture.sqlite
      .prepare('SELECT message FROM notification_outbox ORDER BY id')
      .all()
      .map((row) => row.message)
  ).toEqual(['受影响服务：支付服务、Service', '受影响服务：Service'])
})
it.each([
  ['incident', 'investigating', '故障事件'],
  ['maintenance', 'scheduled', '计划维护'],
])('renders the %s kind on announcement publication and update', async (kind, status, label) => {
  await seed()
  await call('settings/notification-templates', 'PUT', {
    ...custom,
    event: '公告类型：{{kind}}\n{{body}}',
  })
  const event = {
    id: 'event',
    kind,
    status,
    title: '公告',
    start_at: 1,
    published: 1,
    components: ['service'],
    notificationChannels: ['hook'],
    body: '首次发布',
  }
  await call('events', 'POST', event)
  await call('events/event', 'PUT', { ...event, version: 1, body: '追加进展' })
  expect(
    fixture.sqlite
      .prepare('SELECT message FROM notification_outbox ORDER BY id')
      .all()
      .map((row) => row.message)
  ).toEqual([`公告类型：${label}\n首次发布`, `公告类型：${label}\n追加进展`])
})
