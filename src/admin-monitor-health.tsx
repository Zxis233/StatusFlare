import { Badge, Text } from '@mantine/core'

interface MonitorReading {
  name: string
  enabled: number
  version: number
  result_version?: number | null
  interval: number
  status?: string | null
  checked_at?: number | null
  latency?: number | null
}

export default function AdminMonitorHealth({ monitor }: { monitor: MonitorReading }) {
  const hasResult = !!monitor.checked_at
  const currentVersion = monitor.version === monitor.result_version
  const stale = hasResult && Date.now() / 1000 - monitor.checked_at! > monitor.interval * 2 + 30
  const health = !monitor.enabled
    ? { label: '已暂停', color: 'gray', hint: '监控已暂停，不再进行检测。' }
    : !hasResult
    ? { label: '待检测', color: 'gray', hint: '尚未获得检测结果。' }
    : !currentVersion
    ? { label: '待检测', color: 'gray', hint: '配置已更新，等待新配置的检测结果。' }
    : stale
    ? {
        label: '数据过期',
        color: 'yellow',
        hint: '最新结果超过检测间隔的两倍加 30 秒，无法确认当前健康状态。',
      }
    : monitor.status === 'up'
    ? { label: '正常', color: 'teal', hint: '最近一次检测正常。' }
    : monitor.status === 'down'
    ? { label: '异常', color: 'red', hint: '最近一次检测失败。' }
    : { label: '暂无有效数据', color: 'gray', hint: '没有可用的健康状态。' }
  const hasLatency =
    hasResult &&
    currentVersion &&
    typeof monitor.latency === 'number' &&
    Number.isFinite(monitor.latency) &&
    monitor.latency >= 0
  const failed = hasResult && currentVersion && monitor.status === 'down'
  const historic = !monitor.enabled || stale

  return (
    <div className="admin-monitor-readings" role="group" aria-label={`${monitor.name} 检测结果`}>
      <div className="admin-monitor-stat">
        <Text className="admin-monitor-stat-label">健康状态</Text>
        <Badge
          color={health.color}
          variant="light"
          className="admin-health-badge"
          title={health.hint}
        >
          <span className="admin-health-dot" />
          {health.label}
        </Badge>
      </div>
      <div
        className="admin-monitor-stat"
        title={
          hasLatency
            ? '最近一次检测耗时；失败检测的耗时不代表成功响应时间。'
            : '尚无当前配置的有效检测耗时。'
        }
      >
        <Text className="admin-monitor-stat-label">{failed ? '检测耗时' : '响应时间'}</Text>
        <div
          className={`admin-monitor-latency${historic || !hasLatency ? ' is-muted' : ''}${
            failed && !historic ? ' is-failed' : ''
          }`}
        >
          {hasLatency ? (
            <>
              {Math.round(monitor.latency!).toLocaleString()}
              <span>ms</span>
            </>
          ) : (
            '—'
          )}
        </div>
        {hasLatency && (historic || failed) && (
          <Text className="admin-monitor-reading-note">{historic ? '上次检测' : '失败检测'}</Text>
        )}
      </div>
    </div>
  )
}
