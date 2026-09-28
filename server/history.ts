// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import type { DailyStat } from '../shared/models'
export const DAY = 86400
export function splitInterval(
  start: number,
  end: number,
  up: boolean
): Omit<DailyStat, 'monitor_id'>[] {
  const parts: Omit<DailyStat, 'monitor_id'>[] = []
  while (start < end) {
    const day = Math.floor(start / DAY) * DAY,
      until = Math.min(day + DAY, end),
      seconds = until - start
    parts.push({
      day,
      up_seconds: up ? seconds : 0,
      down_seconds: up ? 0 : seconds,
      latency_sum: 0,
      samples: 0,
    })
    start = until
  }
  return parts
}
export function availability(stats: { up_seconds: number; down_seconds: number }[]) {
  const up = stats.reduce((n, s) => n + s.up_seconds, 0),
    down = stats.reduce((n, s) => n + s.down_seconds, 0)
  return up + down ? (up / (up + down)) * 100 : null
}
