// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { database } from './database'
import { api } from '../server/api'
import { now, seal } from '../server/core'
import { invocationEnv } from '../server/limits'

let fixture: ReturnType<typeof database>
beforeEach(async () => {
  fixture = database()
  const encrypted = await seal(fixture.env, { url: 'https://example.com/hook' })
  fixture.sqlite
    .prepare('INSERT INTO notification_channels(id,name,config) VALUES (?,?,?)')
    .run('channel', 'Webhook', encrypted)
  fixture.sqlite.exec("INSERT INTO free_history(hour,samples) VALUES (0,'{}')")
  const states = ['pending', 'sending', 'sent', 'failed', 'cancelled']
  for (let i = 0; i < 130; i++) {
    fixture.sqlite
      .prepare('INSERT INTO audit_logs VALUES (?,?,?,?,?)')
      .run(`audit-${i}`, 'admin', 'channel.test', 'channel', now() - i)
    fixture.sqlite
      .prepare(
        'INSERT INTO notification_outbox(id,channel_id,message,state,available_at,created_at) VALUES (?,?,?,?,?,?)'
      )
      .run(`notification-${i}`, 'channel', 'message', states[i % states.length], now(), now() - i)
  }
})
afterEach(() => fixture.sqlite.close())

async function clear(
  value: unknown = { confirm: true },
  options: { authenticated?: boolean; origin?: string; method?: string } = {}
) {
  const scope = invocationEnv(fixture.env)
  const method = options.method || 'POST'
  try {
    return await api(
      new Request('http://localhost/api/admin/activity/clear', {
        method,
        headers: {
          'content-type': 'application/json',
          ...(options.authenticated === false ? {} : { authorization: 'Bearer test-token' }),
          ...(options.origin ? { origin: options.origin } : {}),
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(value) }),
      }),
      scope.env
    )
  } finally {
    await scope.finish()
  }
}

function count(table: 'audit_logs' | 'notification_outbox') {
  return fixture.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count
}

it('clears all audit and delivery records beyond the overview limit, including every queue state', async () => {
  const channels = fixture.sqlite.prepare('SELECT * FROM notification_channels').all()
  const settings = fixture.sqlite.prepare('SELECT * FROM settings').all()
  const history = fixture.sqlite.prepare('SELECT * FROM free_history').all()
  const response = await clear()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, deleted: { deliveries: 130, audits: 130 } })
  expect(count('audit_logs')).toBe(0)
  expect(count('notification_outbox')).toBe(0)
  expect(fixture.sqlite.prepare('SELECT * FROM notification_channels').all()).toEqual(channels)
  expect(fixture.sqlite.prepare('SELECT * FROM settings').all()).toEqual(settings)
  expect(fixture.sqlite.prepare('SELECT * FROM free_history').all()).toEqual(history)
  expect(await (await clear()).json()).toEqual({ ok: true, deleted: { deliveries: 0, audits: 0 } })
})

it.each([{}, { confirm: false }])(
  'requires explicit confirmation (%j) before deleting',
  async (value) => {
    await expect(clear(value)).rejects.toMatchObject({ name: 'ZodError' })
    expect(count('audit_logs')).toBe(130)
    expect(count('notification_outbox')).toBe(130)
  }
)

it('rejects unauthenticated and cross-site requests without deleting data', async () => {
  Object.assign(fixture.env, {
    ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
    ACCESS_AUD: 'aud',
    ADMIN_EMAILS: 'admin@example.com',
  })
  await expect(clear({ confirm: true }, { authenticated: false })).rejects.toMatchObject({
    status: 401,
  })
  await expect(
    clear({ confirm: true }, { origin: 'https://other.example.com' })
  ).rejects.toMatchObject({ status: 403 })
  expect(count('audit_logs')).toBe(130)
  expect(count('notification_outbox')).toBe(130)
})

it('does not clear data through a GET request or after the write budget is exhausted', async () => {
  await expect(clear(undefined, { method: 'GET' })).rejects.toMatchObject({ status: 404 })
  fixture.sqlite
    .prepare('INSERT INTO free_usage(day,writes) VALUES (?,?)')
    .run(Math.floor(now() / 86400), 80000)
  await expect(clear()).rejects.toMatchObject({ status: 429 })
  expect(count('audit_logs')).toBe(130)
  expect(count('notification_outbox')).toBe(130)
})

it('rolls back delivery deletion when audit deletion fails', async () => {
  fixture.sqlite.exec(
    "CREATE TRIGGER reject_audit_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit delete blocked'); END"
  )
  await expect(clear()).rejects.toThrow('audit delete blocked')
  expect(count('audit_logs')).toBe(130)
  expect(count('notification_outbox')).toBe(130)
})
