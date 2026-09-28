// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
export type Health = 'up' | 'down' | 'unknown' | 'paused' | 'maintenance'
export type EventStatus =
  | 'investigating'
  | 'identified'
  | 'monitoring'
  | 'resolved'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
export interface Group {
  id: string
  name: string
  position: number
  version: number
}
export interface Component {
  id: string
  name: string
  description: string
  group_id: string | null
  public: number
  position: number
  link: string
  version: number
}
export interface ProbeConfig {
  target: string
  method: string
  timeout: number
  headers: Record<string, string>
  body: string
  expectedCodes: number[]
  responseKeyword: string
  responseForbiddenKeyword: string
  region: string
  fallback: boolean
}
export interface Monitor {
  id: string
  name: string
  link: string
  component_id: string
  position: number
  enabled: number
  interval: number
  grace: number
  notify: number
  version: number
  next_check_at: number
  manual_check_at?: number
  created_at: number
  config: ProbeConfig
}
export interface MonitorRow extends Omit<Monitor, 'config'> {
  config: string
}
export interface EventUpdate {
  id: string
  event_id: string
  status: EventStatus
  body: string
  created_at: number
}
export interface StatusEvent {
  id: string
  kind: 'incident' | 'maintenance'
  title: string
  status: EventStatus
  severity: 'minor' | 'major' | 'critical'
  start_at: number
  end_at: number | null
  published: number
  created_at: number
  updated_at: number
  version: number
  components: string[]
  updates: EventUpdate[]
  moreUpdates?: boolean
}
export interface DailyStat {
  monitor_id: string
  day: number
  up_seconds: number
  down_seconds: number
  latency_sum: number
  samples: number
}
export interface PublicMonitor {
  id: string
  name: string
  link: string
  component_id: string
  status: Health
  checked_at: number | null
  latency: number | null
  history: DailyStat[]
}
export interface PublicData {
  settings: {
    title: string
    description: string
    backgroundImageUrl?: string
    backgroundDim?: number
  }
  groups: Group[]
  components: Component[]
  monitors: PublicMonitor[]
  events: StatusEvent[]
  now: number
  refreshSeconds?: number
}
export const statusLabels: Record<string, string> = {
  up: '正常',
  down: '异常',
  unknown: '暂无有效数据',
  paused: '已暂停',
  maintenance: '维护中',
  investigating: '调查中',
  identified: '已定位',
  monitoring: '观察中',
  resolved: '已解决',
  scheduled: '已计划',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
}
