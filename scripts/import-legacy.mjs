// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { prepareHistory } from './prepare-history.mjs'
const base = process.env.STATUSFLARE_URL?.replace(/\/$/, '')
const token = process.env.ADMIN_API_TOKEN || process.env.DEV_ADMIN_TOKEN
if (!base || !token)
  throw new Error('Set STATUSFLARE_URL and ADMIN_API_TOKEN (or DEV_ADMIN_TOKEN locally).')
const config = JSON.parse(await readFile(process.argv[2] || '.local/legacy-config.json', 'utf8'))
await mkdir('.local', { recursive: true })
const journalPath = `.local/import-${createHash('sha256')
  .update(base)
  .digest('hex')
  .slice(0, 16)}.json`
let journal = { created: [] }
try {
  journal = JSON.parse(await readFile(journalPath, 'utf8'))
} catch (e) {
  if (e.code !== 'ENOENT') throw e
}
journal.keys ||= {}
async function saveJournal() {
  await writeFile(`${journalPath}.tmp`, JSON.stringify(journal), { mode: 0o600 })
  await rename(`${journalPath}.tmp`, journalPath)
}
async function api(path, method = 'GET', value) {
  const response = await fetch(`${base}/api/admin/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: value ? JSON.stringify(value) : undefined,
    redirect: 'error',
  })
  const result = await response.json()
  if (!response.ok) {
    const e = new Error(`${path}: ${result.error || response.status}`)
    e.status = response.status
    throw e
  }
  return result
}
let state = null
if (process.argv[3]) {
  const input = JSON.parse(await readFile(process.argv[3], 'utf8'))
  // Accept a raw state object, SELECT result, or Wrangler --json query output.
  const raw = Array.isArray(input)
    ? input[0]?.results?.[0]?.value ?? input[0]?.value
    : input.value ?? input
  state = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!state || !state.incident || !Number.isFinite(state.lastUpdate))
    throw new Error('Invalid legacy state export')
}
const before = await api('overview')
const policy = before.policy
if (!policy) throw new Error('The server must expose application limits before importing.')
const existingRate = before.monitors
  .filter((m) => m.enabled)
  .reduce((n, m) => n + 86400 / m.interval, 0)
const pending = config.monitors.filter(
  (m) => m.enabled && !before.monitors.some((old) => old.id === m.id && old.enabled)
).length
if (pending && existingRate >= policy.checksPerDay)
  throw new Error(
    'Existing monitors already consume the check budget. Increase their intervals before importing.'
  )
if (new Set([...before.monitors, ...config.monitors].map((m) => m.id)).size > policy.maxMonitors)
  throw new Error(`At most ${policy.maxMonitors} monitors are supported.`)
if ((config.channels || []).filter((channel) => channel.enabled !== 0).length > policy.maxChannels)
  throw new Error(`Enable at most ${policy.maxChannels} notification channels before importing.`)
const minimum = Math.max(
  policy.defaultInterval,
  Math.ceil((pending * 86400) / Math.max(1, policy.checksPerDay - existingRate) / 60) * 60
)
for (const m of config.monitors) {
  const interval = Math.max(minimum, m.interval || 0)
  if (interval !== m.interval) console.log(`${m.id} interval set to ${interval} seconds`)
  m.interval = interval
}
if (!before.monitors.length && !before.components.length && config.settings)
  await api('settings', 'PUT', config.settings)
for (const kind of ['groups', 'components'])
  for (const row of config[kind] || []) {
    try {
      await api(kind, 'POST', row)
    } catch (e) {
      if (e.status !== 409) throw e
    }
  }
for (const m of config.monitors || []) {
  let created = false
  // Save the identity BEFORE making the create request, so a lost response is recoverable.
  journal.keys[m.id] ||= randomUUID()
  await saveJournal()
  try {
    await api('monitors', 'POST', { ...m, enabled: 0, import_key: journal.keys[m.id] })
    created = true
    journal.created.push(m.id)
    await saveJournal()
  } catch (e) {
    if (e.status !== 409) throw e
  }
  const current = await api(`monitors/${m.id}`)
  // Never alter an existing active monitor, even when this tool is rerun.
  if (
    !created &&
    ((!journal.created.includes(m.id) && current.import_owner !== journal.keys[m.id]) ||
      current.enabled ||
      current.checked_at ||
      current.version !== 1)
  ) {
    console.log(`Skipped existing monitor ${m.id}`)
    continue
  }
  if (state) {
    const prepared = prepareHistory(state, m.id)
    let progress,
      offset = 0
    do {
      progress = await api(`monitors/${m.id}/import-history`, 'POST', {
        format: 'prepared-v1',
        digest: prepared.digest,
        total: prepared.rows.length,
        offset,
        rows: prepared.rows.slice(offset, offset + policy.importRows),
      })
      offset = progress.nextOffset
    } while (progress.continue)
  }
  await api(`monitors/${m.id}`, 'PUT', { ...current, interval: m.interval, enabled: m.enabled })
  console.log(`Imported monitor ${m.id}${state ? ' with history' : ''}`)
}
// Channels are imported after monitors/history. Announcements remain drafts.
for (const kind of ['channels', 'events'])
  for (const row of config[kind] || []) {
    try {
      await api(kind, 'POST', row)
    } catch (e) {
      if (e.status !== 409) throw e
    }
  }
console.log(
  'Import complete. Existing records were not overwritten; legacy D1 state was not deleted.'
)
