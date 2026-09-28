// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
// Precompute history locally to keep each import request small.
import { createHash } from 'node:crypto'
export function prepareHistory(state, monitorId) {
  const end = state.lastUpdate,
    source = state.incident?.[monitorId]
  const incident = Array.isArray(source)
    ? source
    : source
    ? source.start.map((start, i) => ({ start, end: source.end[i], error: source.error[i] }))
    : []
  const start = Math.max(
    end - 90 * 86400,
    incident.length ? Math.min(...incident.map((i) => i.start[0])) : end
  )
  const ranges = incident
    .filter((i) => i.error[0] !== 'dummy')
    .map((i) => ({ start: Math.max(start, i.start[0]), end: Math.min(end, i.end ?? end) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start)
  const merged = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  const days = new Map()
  function add(a, b, up) {
    while (a < b) {
      const day = Math.floor(a / 86400) * 86400,
        until = Math.min(day + 86400, b),
        row = days.get(day) || { kind: 'daily', day, up: 0, down: 0, latency: 0, samples: 0 }
      row[up ? 'up' : 'down'] += until - a
      days.set(day, row)
      a = until
    }
  }
  let cursor = start
  for (const range of merged) {
    add(cursor, range.start, true)
    add(range.start, range.end, false)
    cursor = range.end
  }
  add(cursor, end, true)
  const raw = state.latency?.[monitorId]
  let latency = []
  if (Array.isArray(raw)) latency = raw
  else if (raw) {
    const times = Buffer.from(raw.time, 'hex'),
      pings = Buffer.from(raw.ping, 'hex'),
      locations = []
    for (let i = 0; i < raw.loc.v.length; i++)
      for (let n = 0; n < raw.loc.c[i]; n++) locations.push(raw.loc.v[i])
    if (
      times.length % 4 ||
      pings.length % 2 ||
      times.length / 4 !== pings.length / 2 ||
      times.length / 4 !== locations.length
    )
      throw new Error(`Invalid latency encoding for ${monitorId}`)
    latency = locations.map((loc, i) => ({
      time: times.readUInt32LE(i * 4),
      ping: pings.readUInt16LE(i * 2),
      loc,
    }))
  }
  for (const point of latency.filter((p) => p.time >= end - 90 * 86400 && p.time <= end)) {
    const day = Math.floor(point.time / 86400) * 86400,
      row = days.get(day) || { kind: 'daily', day, up: 0, down: 0, latency: 0, samples: 0 }
    row.latency += Math.round(point.ping)
    row.samples++
    days.set(day, row)
  }
  const rows = [...days.values()].sort((a, b) => a.day - b.day)
  rows.push(...merged.map((r) => ({ kind: 'outage', ...r })))
  rows.push(
    ...latency
      .filter((p) => p.time >= end - 7 * 86400 && p.time <= end)
      .map((p) => ({
        kind: 'result',
        time: p.time,
        ping: Math.round(p.ping),
        loc: p.loc,
        up: merged.some((r) => p.time >= r.start && p.time < r.end) ? 0 : 1,
      }))
  )
  return { digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), rows }
}
