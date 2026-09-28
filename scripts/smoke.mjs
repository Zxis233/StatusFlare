// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
// Integration check against a LOCAL Wrangler instance only. Creates isolated demo records.
import assert from 'node:assert/strict'
const base = process.env.SMOKE_URL || 'http://127.0.0.1:8787'
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname))
  throw new Error('Smoke tests only run locally')
const token = process.env.SMOKE_TOKEN || 'local-development-only',
  suffix = Date.now().toString(36)
async function call(path, method = 'GET', value, auth = true) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: value ? JSON.stringify(value) : undefined,
  })
  const data = await res.json()
  return { status: res.status, data }
}
const group = `demo-group-${suffix}`,
  component = `demo-service-${suffix}`,
  monitor = `000-smoke-monitor-${suffix}`,
  event = `demo-event-${suffix}`
assert.equal((await call('/api/health')).status, 200)
assert.notEqual((await call('/api/admin/me', 'GET', undefined, false)).status, 200)
assert.equal(
  (await call('/api/admin/groups', 'POST', { id: group, name: '演示服务', position: 0 })).status,
  201
)
assert.equal(
  (
    await call('/api/admin/components', 'POST', {
      id: component,
      name: '示例网站',
      description: '本地验证使用的公开服务',
      group_id: group,
    })
  ).status,
  201
)
const config = { target: 'https://example.com', method: 'GET', timeout: 5000 }
assert.equal(
  (
    await call('/api/admin/monitors', 'POST', {
      id: monitor,
      name: 'HTTPS 可用性',
      component_id: component,
      config,
      interval: 3600,
      notify: 0,
    })
  ).status,
  201
)
const t = Math.floor(Date.now() / 1000)
const draft = {
  id: event,
  kind: 'incident',
  title: '本地验证：服务访问异常',
  status: 'investigating',
  start_at: t - 600,
  components: [component],
  body: '正在排查连接问题。',
  published: 0,
}
assert.equal((await call('/api/admin/events', 'POST', draft)).status, 201)
assert.ok(!(await call('/api/status')).data.events.some((e) => e.id === event))
assert.equal(
  (
    await call(`/api/admin/events/${event}`, 'PUT', {
      ...draft,
      status: 'resolved',
      end_at: t,
      body: '服务已恢复，验证完成。',
      published: 1,
      version: 1,
    })
  ).status,
  200
)
const publicState = (await call('/api/status')).data
assert.equal((await call(`/api/incidents/${event}/updates`)).data.updates.length, 2)
assert.ok(!JSON.stringify(publicState).includes('https://example.com'))
const prior = (await call('/api/admin/overview')).data
// A future simulated Cron timestamp cannot bypass the real execution-minute limit.
const nextMinute = ((prior.usage?.check_slot ?? -1) + 1) * 60000
if (nextMinute > Date.now())
  await new Promise((resolve) => setTimeout(resolve, nextMinute - Date.now() + 50))
const scheduledTime = Date.now()
const cron = await fetch(`${base}/__scheduled?time=${scheduledTime}`)
assert.equal(cron.status, 200)
let overview = (await call('/api/admin/overview')).data
const deadline = Date.now() + 30000
const hasNewResult = () =>
  overview.monitors.some(
    (m) =>
      m.checked_at >= t &&
      m.checked_at !== prior.monitors.find((old) => old.id === m.id)?.checked_at
  )
while (!hasNewResult() && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  overview = (await call('/api/admin/overview')).data
}
assert.ok(hasNewResult(), 'Scheduled handler persisted a real probe result')
if (overview.storage) {
  const uploaded = await fetch(`${base}/api/admin/attachments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'text/plain',
      'x-file-name': 'smoke.txt',
    },
    body: 'Local attachment test',
  })
  assert.equal(uploaded.status, 201)
  const file = await uploaded.json()
  assert.notEqual(
    (await fetch(`${base}${file.url}`)).status,
    200,
    'Unpublished attachment must not be public'
  )
  assert.equal(
    (
      await call(`/api/admin/events/${event}`, 'PUT', {
        ...draft,
        status: 'resolved',
        end_at: t,
        published: 1,
        version: 2,
        body: `验证附件：[日志](${file.url})`,
        attachments: [file.id],
      })
    ).status,
    200
  )
  assert.equal(
    (await fetch(`${base}${file.url}`)).status,
    200,
    'Published attachment is accessible'
  )
  assert.equal(
    (
      await call(`/api/admin/events/${event}`, 'PUT', {
        ...draft,
        status: 'resolved',
        end_at: t,
        published: 1,
        version: 3,
        body: '追加更新，保留既有附件。',
        attachments: [],
      })
    ).status,
    200
  )
  assert.equal(
    (await fetch(`${base}${file.url}`)).status,
    200,
    'Appending an update preserves existing attachment permissions'
  )
}
assert.equal((await call(`/api/monitors/${monitor}/history`)).status, 200)
assert.equal((await fetch(`${base}/admin`)).status, 200)
console.log(
  'Local smoke passed: authentication, D1 CRUD, draft/publish/update, privacy, real Cron probe, history, and SPA fallback.'
)
console.log(`Demo IDs: ${component}, ${monitor}, ${event}`)
