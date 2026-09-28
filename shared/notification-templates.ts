export const templateLimit = 4000
export const notificationTestScenarios = ['down', 'recovery', 'incident', 'maintenance'] as const
export type NotificationTestScenario = (typeof notificationTestScenarios)[number]
export function renderNotificationTest(
  templates: NotificationTemplates,
  scenario: NotificationTestScenario,
  seconds: number
): string {
  const maintenance = scenario === 'maintenance'
  const kind = scenario === 'down' || scenario === 'recovery' ? scenario : 'event'
  return (
    '[测试通知] 以下为示例数据，不代表实际事件。\n\n' +
    renderNotificationTemplate(templates[kind], {
      monitorName: '网站首页',
      reason: 'HTTP 503',
      title: maintenance ? '网站计划维护' : '网站访问异常',
      kind: maintenance ? '计划维护' : '故障事件',
      status: maintenance ? '已计划' : '调查中',
      severity: '主要故障',
      services: '网站首页、用户中心、支付服务',
      body: maintenance
        ? '我们将进行系统升级，期间服务可能短暂中断。'
        : '我们正在排查问题，将持续更新进展。',
      time: formatNotificationTime(seconds, templates.timeZone),
      startTime: formatNotificationTime(seconds, templates.timeZone),
      endTime: maintenance ? formatNotificationTime(seconds + 3600, templates.timeZone) : '待定',
    })
  )
}
export const notificationKindLabels = {
  incident: '故障事件',
  maintenance: '计划维护',
}
export const notificationSeverityLabels = {
  minor: '轻微影响',
  major: '主要故障',
  critical: '严重故障',
}
export const defaultNotificationTemplates = {
  timeZone: 'UTC',
  down: '🔴 检测异常 · {{monitorName}}\n{{reason}}\n{{time}}',
  recovery: '✅ 已恢复 · {{monitorName}}\n服务已恢复正常\n{{time}}',
  event: '{{title}}\n{{status}}\n{{body}}',
}
export type NotificationTemplates = typeof defaultNotificationTemplates
export type NotificationTemplateKind = Exclude<keyof NotificationTemplates, 'timeZone'>
export const notificationTemplateFields: Record<
  NotificationTemplateKind,
  Record<string, string>
> = {
  down: { monitorName: '监控名称', reason: '异常原因', time: '检测时间（所选时区）' },
  recovery: { monitorName: '监控名称', time: '检测时间（所选时区）' },
  event: {
    title: '公告标题',
    kind: '公告类型（故障事件 / 计划维护）',
    status: '中文状态名称',
    severity: '影响程度（轻微影响 / 主要故障 / 严重故障）',
    services: '受影响的服务名称（按关联顺序，以顿号分隔）',
    body: '本次进展正文',
    time: '通知生成时间（所选时区）',
    startTime: '预计开始时间（所选时区）',
    endTime: '预计结束时间（所选时区），未设置时为“待定”',
  },
}
export const notificationTemplateLabels: Record<NotificationTemplateKind, string> = {
  down: '检测异常',
  recovery: '检测恢复',
  event: '公告发布 / 更新',
}
export const notificationTemplateKinds: NotificationTemplateKind[] = ['down', 'recovery', 'event']

export function isNotificationTimeZone(value: string): boolean {
  if (!value || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(value))
    return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export function formatNotificationTime(seconds: number, timeZone = 'UTC'): string {
  const date = new Date(seconds * 1000)
  // Preserve the existing UTC format for installations that have not opted in.
  if (timeZone === 'UTC') return date.toISOString()
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part(
    'second'
  )} ${part('timeZoneName').replace('GMT', 'UTC')}`
}

export function renderNotificationTemplate(
  template: string,
  values: Record<string, string>
): string {
  // A single pass keeps placeholder-like text in titles/reasons/bodies literal.
  return template.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (match, key: string) =>
    Object.hasOwn(values, key.trim()) ? values[key.trim()] : match
  )
}

export function notificationTemplateError(
  kind: NotificationTemplateKind,
  value: string
): string | null {
  if (!value.trim()) return '模板不能为空；可使用“恢复默认”'
  if (value.length > templateLimit) return `模板最多 ${templateLimit} 个字符`
  for (const match of value.matchAll(/\{\{([^{}]*)\}\}/g)) {
    if (!Object.hasOwn(notificationTemplateFields[kind], match[1].trim()))
      return `不支持的变量：${match[0]}`
  }
  if (/[{}]{2}/.test(value.replace(/\{\{[^{}]*\}\}/g, ''))) return '变量格式错误，请使用 {{变量名}}'
  return null
}
