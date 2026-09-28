// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { useEffect, useRef, useState } from 'react'
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Paper,
  Select,
  Stack,
  Text,
  Title,
  Tooltip,
  useComputedColorScheme,
} from '@mantine/core'
import ReactMarkdown from 'react-markdown'
import { Line } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip as ChartTooltip,
  Filler,
} from 'chart.js'
import type { PublicData, PublicMonitor, StatusEvent, Health, DailyStat } from '../shared/models'
import { statusLabels } from '../shared/models'
import { availability } from '../server/history'
import { request, formatTime } from './api'
import Timeline from './timeline'
import PageBackground from './page-background'
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ChartTooltip, Filler)
ChartJS.defaults.font.family = "'MiSans VF', sans-serif"
export function EventCard({ event, names }: { event: StatusEvent; names: Record<string, string> }) {
  return (
    <Paper withBorder p="lg" className="event-card public-card">
      <Group justify="space-between" align="start">
        <div>
          <Group gap="xs">
            <Badge
              variant="light"
              color={
                ['resolved', 'completed'].includes(event.status)
                  ? 'teal'
                  : event.kind === 'maintenance'
                  ? 'blue'
                  : 'orange'
              }
            >
              {statusLabels[event.status]}
            </Badge>
            <Text size="xs" c="dimmed">
              {event.kind === 'maintenance' ? '计划维护' : '故障事件'}
            </Text>
          </Group>
          <Title order={3} mt="sm">
            {event.title}
          </Title>
        </div>
        <Text size="xs" c="dimmed">
          {formatTime(event.start_at)}
          {event.end_at && ` — ${formatTime(event.end_at)}`}
        </Text>
      </Group>
      <Group gap="xs" mt="sm">
        {event.components.map((id) => (
          <Badge key={id} color="gray" variant="outline">
            {names[id] || id}
          </Badge>
        ))}
      </Group>
      <Timeline event={event} />
    </Paper>
  )
}
const historyBands = [
  { minimum: 99.9, color: '#22A68A', label: '≥99.9%' },
  { minimum: 99, color: '#7EB56E', label: '≥99%' },
  { minimum: 95, color: '#D9C452', label: '≥95%' },
  { minimum: 90, color: '#DE7956', label: '≥90%' },
  { minimum: 0, color: '#CC5265', label: '<90%' },
]
const historyNoDataColor = 'light-dark(#ced4da, #454c56)'

function HistoryBars({ monitor }: { monitor: PublicMonitor }) {
  const today = Math.floor(Date.now() / 1000 / 86400) * 86400
  const percent = availability(monitor.history)
  return (
    <>
      <div className="history-bars" role="img" aria-label={`${monitor.name} 最近 90 天可用率`}>
        {Array.from({ length: 90 }, (_, i) => {
          const day = today - (89 - i) * 86400,
            s = monitor.history.find((h) => h.day === day),
            p = s ? availability([s]) : null,
            band = p === null ? undefined : historyBands.find((b) => p >= b.minimum),
            covered = s ? s.up_seconds + s.down_seconds : 0,
            incomplete = covered > 0 && covered < Math.min(86400, Date.now() / 1000 - day) * 0.8
          return (
            <Tooltip
              key={day}
              label={`${new Date(day * 1000).toISOString().slice(0, 10)} UTC · ${
                p === null
                  ? '暂无数据'
                  : `${p.toFixed(3)}% · 已观测 ${(covered / 3600).toFixed(1)} 小时${
                      incomplete ? ' · 观测不完整' : ''
                    }`
              }`}
            >
              <span
                className={incomplete ? 'history-incomplete' : undefined}
                style={{
                  backgroundColor: band?.color ?? historyNoDataColor,
                }}
              />
            </Tooltip>
          )
        })}
      </div>
      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          90 天前
        </Text>
        <Text size="xs" c="dimmed">
          {percent === null ? '暂无可用率' : `已观测时段可用率 ${percent.toFixed(3)}%`} · UTC
        </Text>
        <Text size="xs" c="dimmed">
          今天
        </Text>
      </Group>
    </>
  )
}
interface MonitorHistory {
  daily: DailyStat[]
  samples: { checked_at: number; latency: number; up: number }[]
  outages: { id: string; start_at: number; end_at: number | null }[]
}
interface CachedHistory {
  checkedAt: number | null
  detail?: MonitorHistory
  pending?: Promise<MonitorHistory>
}
type HistoryCache = Map<string, CachedHistory>

function loadMonitorHistory(cache: HistoryCache, monitor: PublicMonitor): Promise<MonitorHistory> {
  const existing = cache.get(monitor.id)
  if (existing?.checkedAt === monitor.checked_at) {
    if (existing.detail) return Promise.resolve(existing.detail)
    if (existing.pending) return existing.pending
  }
  const entry: CachedHistory = { checkedAt: monitor.checked_at }
  cache.set(monitor.id, entry)
  entry.pending = request<MonitorHistory>(`/api/monitors/${monitor.id}/history`)
    .then((detail) => {
      if (cache.get(monitor.id) === entry) {
        entry.detail = detail
        entry.pending = undefined
      }
      return detail
    })
    .catch((error) => {
      // Failed requests may be retried on the next expansion; never evict a newer entry.
      if (cache.get(monitor.id) === entry) cache.delete(monitor.id)
      throw error
    })
  return entry.pending
}

function MonitorDetails({
  monitor,
  historyCache,
}: {
  monitor: PublicMonitor
  historyCache: HistoryCache
}) {
  const dark = useComputedColorScheme('dark') === 'dark'
  const chartText = dark ? '#adb5bd' : '#495057'
  const chartGrid = dark ? '#343b44' : '#e4e9ee'
  const chartBorder = dark ? '#59636f' : '#adb5bd'
  const [detail, setDetail] = useState<MonitorHistory | null>(() => {
      const entry = historyCache.get(monitor.id)
      return entry?.checkedAt === monitor.checked_at ? entry.detail || null : null
    }),
    [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setError('')
    const entry = historyCache.get(monitor.id)
    setDetail(entry?.checkedAt === monitor.checked_at ? entry.detail || null : null)
    loadMonitorHistory(historyCache, monitor)
      .then((value) => {
        if (active) setDetail(value)
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [monitor.id, monitor.checked_at, historyCache])
  return (
    <Stack gap="sm">
      <HistoryBars monitor={{ ...monitor, history: detail?.daily || monitor.history }} />
      {error && <Text c="red">{error}</Text>}
      {detail && (
        <>
          <div style={{ height: 150 }}>
            <Line
              options={{
                responsive: true,
                maintainAspectRatio: false,
                animations: {
                  x: { duration: 0 },
                  y: {
                    duration: 600,
                    easing: 'easeOutQuart',
                    from: (context) => context.chart.scales.y.getPixelForValue(0),
                  },
                },
                plugins: { legend: { display: false } },
                scales: {
                  x: {
                    ticks: { maxTicksLimit: 6, color: chartText },
                    grid: { color: chartGrid },
                    border: { color: chartBorder },
                  },
                  y: {
                    beginAtZero: true,
                    ticks: { color: chartText },
                    title: { display: true, text: 'ms', color: chartText },
                    grid: { color: chartGrid },
                    border: { color: chartBorder },
                  },
                },
              }}
              data={{
                labels: detail.samples.map((s) =>
                  new Date(s.checked_at * 1000).toLocaleTimeString()
                ),
                datasets: [
                  {
                    label: '响应时间',
                    data: detail.samples.map((s) => s.latency),
                    borderColor: '#22a68a',
                    backgroundColor: '#22a68a18',
                    pointRadius: 0,
                    borderWidth: 2,
                    fill: true,
                  },
                ],
              }}
            />
          </div>
          <Text size="xs" c="dimmed">
            最近 12 小时响应时间 · 最后检查：{formatTime(monitor.checked_at)}
          </Text>
          {detail.outages.slice(0, 5).map((o) => (
            <Text key={o.id} size="sm">
              异常：{formatTime(o.start_at)} — {o.end_at ? formatTime(o.end_at) : '尚未检测到恢复'}
            </Text>
          ))}
        </>
      )}
    </Stack>
  )
}
export default function PublicPage() {
  const [data, setData] = useState<PublicData | null>(null),
    [error, setError] = useState(''),
    [history, setHistory] = useState<StatusEvent[]>([]),
    [before, setBefore] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [loadingMore, setLoadingMore] = useState(false)
  const [expanded, setExpanded] = useState<string[]>([])
  const isHistory = window.location.pathname === '/incidents'
  const expandedHistory = useRef(false)
  // Page-local only: no persistent cache, and at most one result/request per visible monitor.
  const historyCache = useRef<HistoryCache>(new Map()).current
  useEffect(() => {
    let active = true
    const refreshHistory = () =>
      request('/api/incidents')
        .then((d) => {
          if (active) {
            setHistory((previous) =>
              expandedHistory.current
                ? [
                    ...d.events,
                    ...previous.filter(
                      (old) =>
                        !d.events.some((e: StatusEvent) => e.id === old.id) &&
                        old.start_at <= d.events.at(-1)?.start_at
                    ),
                  ]
                : d.events
            )
            if (!expandedHistory.current) setBefore(d.nextCursor)
          }
        })
        .catch((e) => {
          if (active) setError(e.message)
        })
    const refresh = () =>
      request<PublicData>('/api/status')
        .then((d) => {
          if (active) {
            const visible = new Map(d.monitors.map((monitor) => [monitor.id, monitor.checked_at]))
            for (const [id, entry] of historyCache) {
              if (!visible.has(id) || visible.get(id) !== entry.checkedAt) historyCache.delete(id)
            }
            setData(d)
            setError('')
            document.title = `${d.settings.title} · StatusFlare`
          }
        })
        .catch((e) => {
          if (active) setError(e.message)
        })
    void refresh()
    const timer = setInterval(() => {
      if (!document.hidden) {
        void refresh()
        if (isHistory) void refreshHistory()
      }
    }, 30000)
    if (isHistory) void refreshHistory()
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [isHistory, historyCache])
  if (!data)
    return (
      <Container size="md" py={80}>
        {error ? <Alert color="red">{error}</Alert> : <Loader />}
      </Container>
    )
  const names = Object.fromEntries(data.components.map((c) => [c.id, c.name]))
  const active = data.events.filter(
    (e) => !['resolved', 'completed', 'cancelled'].includes(e.status) && e.start_at <= data.now
  )
  const statuses = data.monitors.filter((m) => m.status !== 'paused'),
    down = statuses.filter((m) => m.status === 'down').length,
    unknown = statuses.filter((m) => m.status === 'unknown').length
  const upcoming = data.events.filter(
    (e) => e.kind === 'maintenance' && e.status === 'scheduled' && e.start_at > data.now
  )
  const componentHealth = (id: string): Health => {
    if (active.some((e) => e.kind === 'maintenance' && e.components.includes(id)))
      return 'maintenance'
    if (active.some((e) => e.kind === 'incident' && e.components.includes(id))) return 'down'
    const monitors = data.monitors.filter((m) => m.component_id === id && m.status !== 'paused')
    return monitors.some((m) => m.status === 'down')
      ? 'down'
      : !monitors.length || monitors.some((m) => m.status === 'unknown')
      ? 'unknown'
      : 'up'
  }
  const sections = [
    ...data.groups.map((g) => ({ id: g.id, name: g.name })),
    { id: null, name: '其他服务' },
  ]
  return (
    <div className={`public-page${data.settings.backgroundImageUrl ? ' has-background' : ''}`}>
      <PageBackground url={data.settings.backgroundImageUrl} dim={data.settings.backgroundDim} />
      <Container className="public-content" size="md" py="xl">
        <header>
          <Group justify="space-between">
            <a className="brand" href="/">
              ◈ <span>{data.settings.title}</span>
            </a>
            <Group gap="lg">
              <a href="/">运行状态</a>
              <a href="/incidents">事件历史</a>
              <a href="/admin" className="muted">
                管理
              </a>
            </Group>
          </Group>
          <Text c="dimmed" mt="sm">
            {data.settings.description}
          </Text>
        </header>
        {error && (
          <Alert color="orange" mt="lg">
            数据更新失败：{error}。当前显示上次获取的记录。
          </Alert>
        )}
        {!isHistory ? (
          <>
            <Paper p="xl" mt={36} mb="xl" className="summary public-card" withBorder>
              <Group justify="space-between">
                <div>
                  <Text size="xs" tt="uppercase" fw={700} c="dimmed" style={{ letterSpacing: 2 }}>
                    SERVICE STATUS
                  </Text>
                  <Title order={1} mt="sm">
                    {down || active.some((e) => e.kind === 'incident')
                      ? '部分服务异常'
                      : active.some((e) => e.kind === 'maintenance')
                      ? '部分服务维护中'
                      : unknown || !statuses.length
                      ? '正在等待检测数据'
                      : '所有服务运行正常'}
                  </Title>
                  <Text c="dimmed" mt="sm">
                    {data.components.length} 项服务 · {statuses.length} 个启用的监控
                  </Text>
                </div>
                <span
                  className={`status-orb ${
                    down ? 'bad' : unknown || !statuses.length ? 'waiting' : ''
                  }`}
                />
              </Group>
              <Text size="xs" c="dimmed" mt="lg">
                更新于 {formatTime(data.now)} · 每 30 秒刷新
              </Text>
              <Group gap="xs" mt={4} aria-label="历史可用率颜色图例">
                {[...historyBands, { color: historyNoDataColor, label: '暂无数据' }].map((band) => (
                  <Group key={band.label} gap={4} wrap="nowrap">
                    <span
                      aria-hidden="true"
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 2,
                        backgroundColor: band.color,
                      }}
                    />
                    <Text size="xs" c="dimmed">
                      {band.label}
                    </Text>
                  </Group>
                ))}
                <Group gap={4} wrap="nowrap">
                  <span
                    aria-hidden="true"
                    className="history-incomplete"
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      backgroundColor: historyNoDataColor,
                    }}
                  />
                  <Text size="xs" c="dimmed">
                    观测不完整
                  </Text>
                </Group>
              </Group>
            </Paper>
            <Stack mb="xl">
              {[...active, ...upcoming].map((e) => (
                <EventCard key={e.id} event={e} names={names} />
              ))}
            </Stack>
            {!data.components.length && (
              <Alert>还没有公开服务。管理员可在后台添加服务与监控。</Alert>
            )}
            {sections.map((section) => {
              const components = data.components.filter((c) => c.group_id === section.id)
              if (!components.length) return null
              return (
                <section key={section.id || 'other'} className="service-group">
                  <Title fz="xxl" mb="md">
                    {section.name}
                  </Title>
                  <Paper withBorder className="public-card">
                    <Accordion multiple variant="default" value={expanded} onChange={setExpanded}>
                      {components.map((c) => {
                        const health = componentHealth(c.id)
                        return (
                          <Accordion.Item key={c.id} value={c.id}>
                            <Accordion.Control>
                              <Group justify="space-between" wrap="nowrap">
                                <div>
                                  <Text fz="md" fw={600}>
                                    {c.name}
                                  </Text>
                                  {c.description && (
                                    <Text c="dimmed" size="sm">
                                      {c.description}
                                    </Text>
                                  )}
                                </div>
                                <Badge
                                  color={
                                    health === 'up'
                                      ? 'teal'
                                      : health === 'down'
                                      ? 'red'
                                      : health === 'maintenance'
                                      ? 'blue'
                                      : 'gray'
                                  }
                                  variant="light"
                                >
                                  {statusLabels[health]}
                                </Badge>
                              </Group>
                            </Accordion.Control>
                            <Accordion.Panel>
                              <Stack>
                                {c.link && (
                                  <a href={c.link} target="_blank" rel="noreferrer">
                                    访问服务 ↗
                                  </a>
                                )}
                                {data.monitors
                                  .filter((m) => m.component_id === c.id)
                                  .map((m) => (
                                    <div key={m.id}>
                                      <Group justify="space-between" mb="sm">
                                        <div className="monitor-heading">
                                          <Text fz="xs" fw={500} className="monitor-name">
                                            {m.name}
                                          </Text>
                                          {m.link && (
                                            <a
                                              className="monitor-public-link"
                                              href={m.link}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              title={m.link}
                                            >
                                              {m.link} ↗
                                            </a>
                                          )}
                                        </div>
                                        <Text size="xs" c="dimmed">
                                          {statusLabels[m.status]}
                                          {m.latency !== null && ` · ${m.latency} ms`}
                                        </Text>
                                      </Group>
                                      {expanded.includes(c.id) && (
                                        <MonitorDetails monitor={m} historyCache={historyCache} />
                                      )}
                                    </div>
                                  ))}
                              </Stack>
                            </Accordion.Panel>
                          </Accordion.Item>
                        )
                      })}
                    </Accordion>
                  </Paper>
                </section>
              )
            })}
            <Group justify="space-between" mt={40}>
              <Title order={3}>最近事件</Title>
              <a href="/incidents">查看全部 →</a>
            </Group>
            <Stack mt="md">
              {data.events
                .filter((e) => ['resolved', 'completed', 'cancelled'].includes(e.status))
                .slice(0, 3)
                .map((e) => (
                  <EventCard key={e.id} event={e} names={names} />
                ))}
              {!data.events.length && <Text c="dimmed">暂无已发布事件。</Text>}
            </Stack>
          </>
        ) : (
          <>
            <Group justify="space-between" mt={40} mb="xl">
              <Title order={1}>事件历史</Title>
              <Select
                aria-label="筛选受影响服务"
                placeholder="全部服务"
                clearable
                data={data.components.map((c) => ({ value: c.id, label: c.name }))}
                value={selected}
                onChange={setSelected}
              />
            </Group>
            <Stack>
              {history
                .filter((e) => !selected || e.components.includes(selected))
                .map((e) => (
                  <EventCard key={e.id} event={e} names={names} />
                ))}
              {!history.length && <Text c="dimmed">暂无事件记录。</Text>}
              {before && (
                <Button
                  variant="light"
                  loading={loadingMore}
                  onClick={async () => {
                    setLoadingMore(true)
                    try {
                      const d = await request(`/api/incidents?cursor=${encodeURIComponent(before)}`)
                      expandedHistory.current = true
                      setHistory((h) => [
                        ...h,
                        ...d.events.filter((e: StatusEvent) => !h.some((old) => old.id === e.id)),
                      ])
                      setBefore(d.nextCursor)
                    } catch (e) {
                      setError((e as Error).message)
                    } finally {
                      setLoadingMore(false)
                    }
                  }}
                >
                  加载更早事件
                </Button>
              )}
            </Stack>
          </>
        )}
        <footer>
          <Text size="xs" c="dimmed">
            Powered by{' '}
            <a
              href="https://github.com/Zxis233/StatusFlare"
              target="_blank"
              rel="noopener noreferrer"
            >
              StatusFlare
            </a>{' '}
            · Deployed on Cloudflare Workers
          </Text>
        </footer>
      </Container>
    </div>
  )
}
