// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Container,
  Divider,
  Group,
  Loader,
  Modal,
  MultiSelect,
  NumberInput,
  Paper,
  PasswordInput,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core'
import ReactMarkdown from 'react-markdown'
import { useMediaQuery } from '@mantine/hooks'
import { request, downloadEncryptionKey, formatTime, localDate, epoch } from './api'
import { statusLabels } from '../shared/models'
import Timeline from './timeline'
import PageBackground from './page-background'
import NotificationTemplateSettings from './notification-template-settings'
import AdminIcon from './admin-icon'
import AdminMonitorHealth from './admin-monitor-health'

const emptyProbe = {
  target: '',
  method: 'GET',
  timeout: 10000,
  headers: {},
  body: '',
  expectedCodes: [],
  responseKeyword: '',
  responseForbiddenKeyword: '',
  region: '',
  fallback: false,
}
const tabs = [
  ['monitors', '监控'],
  ['components', '服务'],
  ['groups', '分组'],
  ['events', '公告与维护'],
  ['channels', '通知渠道'],
  ['settings', '页面设置'],
  ['activity', '运行记录'],
]
const incidentStatuses = ['investigating', 'identified', 'monitoring', 'resolved'],
  maintenanceStatuses = ['scheduled', 'in_progress', 'completed', 'cancelled']
export default function Admin() {
  const compactNavigation = useMediaQuery('(max-width: 900px)')
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState<string | null>('monitors'),
    [recordSearch, setRecordSearch] = useState(''),
    [confirmActivityClear, setConfirmActivityClear] = useState(false),
    [activityClearError, setActivityClearError] = useState(''),
    [edit, setEdit] = useState<{ kind: string; id?: string } | null>(null),
    [draft, setDraft] = useState<any>({}),
    [token, setToken] = useState(''),
    [headers, setHeaders] = useState('{}'),
    [codes, setCodes] = useState(''),
    [channel, setChannel] = useState(''),
    [testingChannel, setTestingChannel] = useState(false),
    [channelTest, setChannelTest] = useState<{
      ok: boolean
      log: string
      elapsedMs?: number
    } | null>(null),
    [uploading, setUploading] = useState(false)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  const reload = async () => {
    const next = await request('/api/admin/overview')
    setData(next)
    setError('')
  }
  useEffect(() => {
    reload().catch((e) => setError(e.message))
  }, [])
  const perform = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true)
    setError('')
    setSuccess('')
    try {
      await fn()
      await reload()
      setSuccess(message)
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  const patch = (key: string, value: unknown) => setDraft((d: any) => ({ ...d, [key]: value }))
  const probe = (key: string, value: unknown) =>
    setDraft((d: any) => ({ ...d, config: { ...d.config, [key]: value } }))
  async function clearActivity() {
    setBusy(true)
    setActivityClearError('')
    setError('')
    setSuccess('')
    try {
      const result = await request<{
        deleted: { deliveries: number; audits: number }
      }>('/api/admin/activity/clear', {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      })
      setConfirmActivityClear(false)
      setData((previous: any) => ({ ...previous, deliveries: [], audits: [] }))
      setSuccess(
        `已清理 ${result.deleted.deliveries} 条通知投递记录和 ${result.deleted.audits} 条操作记录`
      )
    } catch (e) {
      setActivityClearError((e as Error).message)
      setBusy(false)
      return
    }
    try {
      await reload()
    } catch (e) {
      setError(`清理已完成，但刷新失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  async function open(kind: string, value?: any) {
    setChannelTest(null)
    setError('')
    setSuccess('')
    if ((kind === 'monitors' || kind === 'channels') && value && !value.config) {
      try {
        value = await request(`/api/admin/${kind}/${value.id}`)
      } catch (e) {
        setError((e as Error).message)
        return
      }
    }
    setEdit({ kind, id: value?.id })
    const t = Math.floor(Date.now() / 1000)
    const defaults: any = {
      groups: { name: '', position: 0 },
      components: { name: '', description: '', group_id: null, public: 1, position: 0, link: '' },
      monitors: {
        name: '',
        link: '',
        component_id: data.components[0]?.id || '',
        position: 0,
        enabled: 1,
        interval: data.policy?.defaultInterval || 600,
        grace: 180,
        notify: 1,
        config: emptyProbe,
      },
      events: {
        kind: 'incident',
        title: '',
        status: 'investigating',
        severity: 'minor',
        start_at: t,
        end_at: null,
        published: 0,
        components: [],
        notificationChannels: [],
        body: '',
        attachments: [],
      },
      channels: { name: '', enabled: 1 },
    }
    const d = structuredClone(value ? { ...value } : defaults[kind])
    if (kind === 'events') {
      d.body = ''
      d.attachments = []
      d.notificationChannels = []
    }
    setDraft(d)
    setHeaders(JSON.stringify(d.config?.headers || {}, null, 2))
    setCodes((d.config?.expectedCodes || []).join(', '))
    setChannel(
      value
        ? JSON.stringify(d.config, null, 2) || ''
        : JSON.stringify(
            {
              url: 'https://example.com/webhook',
              payloadType: 'json',
              payload: { text: '$MSG' },
              timeout: 10000,
            },
            null,
            2
          )
    )
  }
  async function save() {
    if (!edit) return
    await perform(async () => {
      const value = { ...draft }
      if (edit.kind === 'monitors')
        value.config = {
          ...draft.config,
          headers: JSON.parse(headers),
          expectedCodes: codes.trim() ? codes.split(',').map((c) => Number(c.trim())) : [],
        }
      if (edit.kind === 'channels' && channel.trim()) value.config = JSON.parse(channel)
      await request(`/api/admin/${edit.kind}${edit.id ? `/${edit.id}` : ''}`, {
        method: edit.id ? 'PUT' : 'POST',
        body: JSON.stringify(value),
      })
      setEdit(null)
    }, '已保存。公开页面会在下一次刷新时显示更新。')
  }
  async function testChannel() {
    if (!edit?.id) return
    setTestingChannel(true)
    setChannelTest(null)
    try {
      setChannelTest(await request(`/api/admin/channels/${edit.id}/test`, { method: 'POST' }))
    } catch (e) {
      setChannelTest({ ok: false, log: (e as Error).message })
    } finally {
      setTestingChannel(false)
    }
  }
  async function remove(kind: string, row: any) {
    if (!window.confirm(`确定删除“${row.name || row.title}”？有关联数据的服务无法删除。`)) return
    await perform(
      () => request(`/api/admin/${kind}/${row.id}?version=${row.version}`, { method: 'DELETE' }),
      '已删除'
    )
  }
  async function upload(file: File) {
    setUploading(true)
    try {
      const r = await request('/api/admin/attachments', {
        method: 'POST',
        headers: {
          'content-type': file.type || 'text/plain',
          'x-file-name': encodeURIComponent(file.name),
        },
        body: file,
      })
      setDraft((d: any) => ({
        ...d,
        attachments: [...(d.attachments || []), r.id],
        body: `${d.body}\n${file.type.startsWith('image/') ? '!' : ''}[${file.name.replace(
          /[\[\]]/g,
          ''
        )}](${r.url})`,
      }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }
  if (!data)
    return (
      <div className="admin-page admin-auth">
        <Container size="xs" py={80}>
          <Paper withBorder className="admin-auth-card">
            <Stack gap="lg">
              <span className="admin-brand-mark">
                <img src="/favicon.svg" width="32" height="32" alt="" />
              </span>
              <Text className="admin-eyebrow">STATUSFLARE / ADMIN</Text>
              <Title order={2}>StatusFlare 管理后台</Title>
              {error ? <Alert color="orange">{error}</Alert> : <Loader />}
              <Text c="dimmed" size="sm">
                生产环境通过 Cloudflare Access 登录。没有权限时请联系站点管理员。
              </Text>
              {local && (
                <>
                  <PasswordInput
                    label="本地开发令牌"
                    description="使用 .dev.vars 中的 DEV_ADMIN_TOKEN"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                  <Button
                    onClick={() => {
                      sessionStorage.setItem('statusflare-local-token', token)
                      reload().catch((e) => setError(e.message))
                    }}
                  >
                    进入本地后台
                  </Button>
                </>
              )}
              <a href="/">← 返回状态页</a>
            </Stack>
          </Paper>
        </Container>
      </div>
    )
  const componentOptions = data.components.map((c: any) => ({ value: c.id, label: c.name })),
    groupOptions = data.groups.map((g: any) => ({ value: g.id, label: g.name }))
  const enabledMonitors = data.monitors.filter((m: any) => m.enabled).length
  const plannedChecks = Math.ceil(
    data.monitors
      .filter((m: any) => m.enabled)
      .reduce((n: number, m: any) => n + 86400 / m.interval, 0)
  )
  const usagePercent = (value: number, limit?: number) =>
    limit ? Math.min(100, (value / limit) * 100) : 0
  return (
    <div className={`admin-page${data.settings.backgroundImageUrl ? ' has-background' : ''}`}>
      <PageBackground url={data.settings.backgroundImageUrl} dim={data.settings.backgroundDim} />
      <Container className="admin-content" size={1440} py="xl">
        <header className="admin-header">
          <Group justify="space-between" gap="md">
            <Group gap="md">
              <a href="/" className="admin-brand-mark" aria-label="StatusFlare 状态页">
                <img src="/favicon.svg" alt="" width="32" height="32" />
              </a>
              <div>
                <Text className="admin-eyebrow">STATUSFLARE / ADMIN</Text>
                <Title order={2}>管理控制台</Title>
              </div>
            </Group>
            <Group gap="sm" className="admin-header-actions">
              <span className="admin-identity">
                <span className="admin-status-dot" />
                {data.actor}
              </span>
              <Button component="a" href="/" variant="default" size="sm">
                查看状态页 ↗
              </Button>
              <Button
                variant="light"
                size="sm"
                leftSection={<AdminIcon name="refresh" size={16} />}
                loading={busy}
                onClick={() => perform(reload, '已刷新')}
              >
                刷新
              </Button>
              {local && (
                <Button
                  variant="subtle"
                  color="gray"
                  onClick={() => {
                    sessionStorage.removeItem('statusflare-local-token')
                    location.reload()
                  }}
                >
                  退出
                </Button>
              )}
            </Group>
          </Group>
        </header>
        <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md" className="admin-metrics">
          {[
            {
              label: '启用监控',
              value: enabledMonitors,
              suffix: `/ ${data.monitors.length}`,
              note: `${data.monitors.length - enabledMonitors} 个已暂停`,
              icon: 'monitors',
            },
            {
              label: '服务',
              value: data.components.length,
              suffix: '个',
              note: `${data.groups.length} 个分组`,
              icon: 'components',
            },
            {
              label: '今日检测',
              value: (data.usage?.checks || 0).toLocaleString(),
              suffix: '次',
              note: `计划 ${plannedChecks.toLocaleString()} 次 / 天`,
              icon: 'activity',
              progress: usagePercent(data.usage?.checks || 0, data.policy?.checksPerDay),
            },
            {
              label: '今日写入',
              value: (data.usage?.writes || 0).toLocaleString(),
              suffix: '行',
              note: data.policy
                ? `预算 ${data.policy.writeBudget.toLocaleString()} 行 / 天`
                : '应用记录的数据库写入',
              icon: 'groups',
              progress: usagePercent(data.usage?.writes || 0, data.policy?.writeBudget),
            },
          ].map((metric) => (
            <Paper withBorder className="admin-metric" key={metric.label}>
              <Group justify="space-between">
                <Text className="admin-metric-label">{metric.label}</Text>
                <AdminIcon name={metric.icon} size={19} />
              </Group>
              <div className="admin-metric-value">
                {metric.value}
                <span>{metric.suffix}</span>
              </div>
              <Text className="admin-metric-note" c="dimmed">
                {metric.note}
              </Text>
              {metric.progress !== undefined && (
                <Progress
                  value={metric.progress}
                  size={3}
                  mt="sm"
                  aria-label={`${metric.label}预算使用率`}
                />
              )}
            </Paper>
          ))}
        </SimpleGrid>
        {data.policy && (
          <details className="admin-usage">
            <summary>
              <span className="admin-status-dot" />
              运行用量与调度限制<span className="admin-usage-hint">查看详情</span>
            </summary>
            <Text size="sm" c="dimmed" mt="sm">
              每分钟最多检查 {data.policy.checksPerMinute} 个到期目标，最短间隔 1 分钟。计划检测{' '}
              {Math.ceil(
                data.monitors
                  .filter((m: any) => m.enabled)
                  .reduce((n: number, m: any) => n + 86400 / m.interval, 0)
              )}{' '}
              / {data.policy.checksPerDay} 次每天；今日已启动 {data.usage?.checks || 0}{' '}
              次。应用已记录写入 {data.usage?.writes || 0} / {data.policy.writeBudget}{' '}
              行。按每分钟上限，每天实际最多 {data.policy.checksPerMinute * 1440} 次；
              超出调度能力的目标会顺延。增加目标时可调大间隔，暂停监控会保留历史。
            </Text>
          </details>
        )}
        {error && (
          <Alert color="red" mt="lg" withCloseButton onClose={() => setError('')}>
            {error}
          </Alert>
        )}
        {success && (
          <Alert color="teal" mt="lg" withCloseButton onClose={() => setSuccess('')}>
            {success}
          </Alert>
        )}
        <Tabs
          value={tab}
          onChange={(value) => {
            setTab(value)
            setRecordSearch('')
          }}
          orientation={compactNavigation ? 'horizontal' : 'vertical'}
          className="admin-tabs"
        >
          <Tabs.List className="admin-nav" aria-label="管理模块">
            <Text className="admin-nav-label">工作空间</Text>
            {tabs.map(([value, label]) => (
              <Tabs.Tab
                key={value}
                value={value}
                aria-label={label}
                leftSection={<AdminIcon name={value} size={18} />}
                rightSection={
                  Array.isArray(data[value]) ? (
                    <span className="admin-nav-count">{data[value].length}</span>
                  ) : undefined
                }
              >
                {label}
              </Tabs.Tab>
            ))}
            <div className="admin-nav-footer">
              <span className="admin-status-dot" />
              更清晰的状态，更及时的响应。
            </div>
          </Tabs.List>
          {['groups', 'components', 'monitors', 'events', 'channels'].map((kind) => (
            <Tabs.Panel key={kind} value={kind} className="admin-panel">
              <Group justify="space-between" mb="lg" className="admin-panel-heading">
                <div>
                  <Title order={3}>{tabs.find((t) => t[0] === kind)?.[1]}</Title>
                  <Text size="sm" c="dimmed">
                    {kind === 'monitors'
                      ? '先创建服务，再添加检测地址。暂停监控会保留历史。'
                      : kind === 'events'
                      ? '发布故障、安排维护，并逐条追加处理进展。'
                      : kind === 'components'
                      ? '服务是公开页面上的展示单元；一个服务可有多个监控。'
                      : kind === 'channels'
                      ? '通知异步发送；失败可在运行记录中查看和重试。'
                      : '分组控制公开页面的结构与顺序。'}
                  </Text>
                </div>
                <Button
                  leftSection={<AdminIcon name="plus" size={17} />}
                  onClick={() => open(kind)}
                  disabled={kind === 'monitors' && !data.components.length}
                >
                  新增
                </Button>
              </Group>
              <Paper withBorder className="admin-records">
                <Group justify="space-between" className="admin-list-toolbar">
                  <Text size="sm" fw={600}>
                    全部记录 <span className="admin-list-count">{data[kind].length}</span>
                  </Text>
                  <TextInput
                    aria-label="搜索当前列表"
                    placeholder="搜索名称…"
                    leftSection={<AdminIcon name="search" size={16} />}
                    value={recordSearch}
                    onChange={(e) => setRecordSearch(e.currentTarget.value)}
                    className="admin-search"
                    size="sm"
                  />
                </Group>
                {!data[kind].length ? (
                  <div className="admin-empty">
                    <span className="admin-empty-icon">
                      <AdminIcon name={kind} size={28} />
                    </span>
                    <Text fw={600}>暂无记录</Text>
                    <Text size="sm" c="dimmed">
                      {kind === 'monitors' && !data.components.length
                        ? '先在“服务”中创建服务，再添加监控。'
                        : '点击“新增”开始配置。'}
                    </Text>
                  </div>
                ) : !data[kind].some((row: any) =>
                    (row.name || row.title || '')
                      .toLowerCase()
                      .includes(recordSearch.trim().toLowerCase())
                  ) ? (
                  <div className="admin-empty">
                    <AdminIcon name="search" size={28} />
                    <Text fw={600}>没有匹配的记录</Text>
                    <Text size="sm" c="dimmed">
                      试试其他名称，或清空搜索。
                    </Text>
                  </div>
                ) : (
                  data[kind]
                    .filter((row: any) =>
                      (row.name || row.title || '')
                        .toLowerCase()
                        .includes(recordSearch.trim().toLowerCase())
                    )
                    .map((row: any) => (
                      <div className="record" key={row.id}>
                        <Group
                          justify="space-between"
                          wrap="nowrap"
                          className="admin-record-layout"
                        >
                          <div className="admin-record-main">
                            <span className="admin-record-icon">
                              <AdminIcon name={kind} />
                            </span>
                            <div className="admin-record-copy">
                              <Group gap="xs">
                                <Text fw={600}>{row.name || row.title}</Text>
                                {kind === 'monitors' && (
                                  <Badge color="gray" variant="outline">
                                    {row.enabled ? '启用' : '暂停'}
                                  </Badge>
                                )}
                                {kind === 'components' && !row.public && (
                                  <Badge color="gray">私有</Badge>
                                )}
                                {kind === 'events' && (
                                  <>
                                    <Badge color={row.published ? 'teal' : 'gray'}>
                                      {row.published ? '已发布' : '草稿'}
                                    </Badge>
                                    <Badge variant="light">{statusLabels[row.status]}</Badge>
                                  </>
                                )}
                              </Group>
                              <Text size="sm" c="dimmed">
                                {kind === 'monitors'
                                  ? `${
                                      row.probeSummary
                                        ? `${row.probeSummary.method} ${row.probeSummary.target}`
                                        : '点击编辑查看检测配置'
                                    } · 每 ${row.interval} 秒 · ${
                                      row.checked_at ? formatTime(row.checked_at) : '尚未检查'
                                    }`
                                  : kind === 'events'
                                  ? `${formatTime(row.start_at)} · ${
                                      row.moreUpdates
                                        ? '有更多历史进展'
                                        : `${row.updates.length} 条进展`
                                    }`
                                  : kind === 'components'
                                  ? row.description
                                  : kind === 'channels'
                                  ? row.enabled
                                    ? '发送已启用'
                                    : '已停用'
                                  : `排序 ${row.position}`}
                              </Text>
                            </div>
                          </div>
                          {kind === 'monitors' && <AdminMonitorHealth monitor={row} />}
                          <Group gap="xs" wrap="nowrap" className="admin-record-actions">
                            {kind === 'monitors' && (
                              <Button
                                size="xs"
                                variant="subtle"
                                disabled={!row.enabled || busy}
                                onClick={() =>
                                  perform(
                                    () =>
                                      request(`/api/admin/monitors/${row.id}/check`, {
                                        method: 'POST',
                                      }),
                                    '已安排下一轮检查'
                                  )
                                }
                              >
                                检查
                              </Button>
                            )}
                            <Button size="xs" variant="light" onClick={() => open(kind, row)}>
                              {kind === 'events' ? '更新' : '编辑'}
                            </Button>
                            {kind !== 'monitors' && (
                              <Button
                                size="xs"
                                color="red"
                                variant="subtle"
                                disabled={busy}
                                onClick={() => remove(kind, row)}
                              >
                                删除
                              </Button>
                            )}
                          </Group>
                        </Group>
                      </div>
                    ))
                )}
              </Paper>
              {kind === 'events' && data.eventsNextCursor && (
                <Button
                  mt="md"
                  variant="light"
                  loading={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      const result = await request(
                        `/api/admin/events?cursor=${encodeURIComponent(data.eventsNextCursor)}`
                      )
                      setData((previous: any) => ({
                        ...previous,
                        events: [
                          ...previous.events,
                          ...result.events.filter(
                            (e: any) => !previous.events.some((old: any) => old.id === e.id)
                          ),
                        ],
                        eventsNextCursor: result.nextCursor,
                      }))
                    } catch (e) {
                      setError((e as Error).message)
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  加载更早公告
                </Button>
              )}
            </Tabs.Panel>
          ))}
          <Tabs.Panel value="settings" className="admin-panel">
            <div className="admin-panel-heading">
              <Title order={3}>页面设置</Title>
              <Text size="sm" c="dimmed">
                打造你的状态页，统一通知风格。
              </Text>
            </div>
            <Paper withBorder p="xl">
              <Title order={4} mb="lg">
                外观与品牌
              </Title>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const form = new FormData(e.currentTarget)
                  perform(
                    () =>
                      request('/api/admin/settings', {
                        method: 'PUT',
                        body: JSON.stringify({
                          ...Object.fromEntries(form),
                          backgroundDim: Number(form.get('backgroundDim')),
                        }),
                      }),
                    '页面设置已保存'
                  )
                }}
              >
                <Stack>
                  <TextInput
                    key={data.settings.title}
                    label="页面标题"
                    name="title"
                    defaultValue={data.settings.title}
                    required
                  />
                  <Textarea
                    key={data.settings.description}
                    label="页面说明"
                    name="description"
                    defaultValue={data.settings.description}
                  />
                  <TextInput
                    key={data.settings.backgroundImageUrl || 'background-url'}
                    label="背景图片 URL"
                    name="backgroundImageUrl"
                    type="url"
                    pattern="https://.*"
                    maxLength={2048}
                    defaultValue={data.settings.backgroundImageUrl || ''}
                    placeholder="https://images.example.com/background.jpg"
                    description="留空恢复纯色背景。图片须允许本站 Origin 的 CORS 请求和 Referer；地址将公开给访客。"
                  />
                  <TextInput
                    key={data.settings.backgroundDim ?? 'background-dim'}
                    label="背景压暗程度"
                    name="backgroundDim"
                    type="number"
                    min={0}
                    max={1}
                    step="any"
                    required
                    defaultValue={data.settings.backgroundDim ?? 0.6}
                    description="0–1：0 不压暗，1 完全压暗。仅影响公开页面背景，不影响文字和卡片。"
                  />
                  <Button type="submit" loading={busy}>
                    保存页面设置
                  </Button>
                </Stack>
              </form>
            </Paper>
            <NotificationTemplateSettings
              key={JSON.stringify(data.notificationTemplates)}
              value={data.notificationTemplates}
              channels={data.channels}
              busy={busy}
              onSave={(value) =>
                perform(
                  () =>
                    request('/api/admin/settings/notification-templates', {
                      method: 'PUT',
                      body: JSON.stringify(value),
                    }),
                  '通知模板已保存，将用于新生成的通知'
                )
              }
            />
            {data.keyExportEnabled && (
              <Paper withBorder p="xl" mt="lg">
                <Stack>
                  <Title order={3}>密钥备份</Title>
                  <Text size="sm">
                    下载当前加密密钥，配合数据库备份用于恢复监控和通知配置。请将文件存入安全位置，不要上传到仓库或发送给他人。
                  </Text>
                  <Button
                    variant="light"
                    loading={busy}
                    onClick={async () => {
                      setBusy(true)
                      setError('')
                      setSuccess('')
                      try {
                        await downloadEncryptionKey()
                        setSuccess(
                          '已发起密钥备份下载，请确认文件已保存，然后在 Cloudflare 中移除 ENABLE_KEY_EXPORT。'
                        )
                      } catch (e) {
                        setError((e as Error).message)
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    下载密钥备份
                  </Button>
                </Stack>
              </Paper>
            )}
          </Tabs.Panel>
          <Tabs.Panel value="activity" className="admin-panel">
            <Group justify="space-between" className="admin-panel-heading">
              <div>
                <Title order={3}>运行记录</Title>
                <Text size="sm" c="dimmed">
                  查看通知投递与管理操作，追踪每一次变化。
                </Text>
              </div>
              <Button
                color="red"
                variant="light"
                disabled={busy}
                leftSection={<AdminIcon name="trash" size={17} />}
                onClick={() => {
                  setActivityClearError('')
                  setConfirmActivityClear(true)
                }}
              >
                一键清理
              </Button>
            </Group>
            <Stack>
              <Title order={3}>通知投递</Title>
              <Paper withBorder>
                {data.deliveries.length ? (
                  data.deliveries.map((d: any) => (
                    <div className="record" key={d.id}>
                      <Group justify="space-between">
                        <div>
                          <Text size="sm">
                            {formatTime(d.created_at)} · {d.state} · 尝试 {d.attempts} 次
                          </Text>
                          {d.error && (
                            <Text size="xs" c="red">
                              {d.error}
                            </Text>
                          )}
                        </div>
                        {d.state === 'failed' && (
                          <Button
                            size="xs"
                            onClick={() =>
                              perform(
                                () =>
                                  request(
                                    `/api/admin/deliveries/${encodeURIComponent(d.id)}/retry`,
                                    {
                                      method: 'POST',
                                    }
                                  ),
                                '已安排重试'
                              )
                            }
                          >
                            重试
                          </Button>
                        )}
                      </Group>
                    </div>
                  ))
                ) : (
                  <Text p="lg" c="dimmed">
                    暂无投递记录
                  </Text>
                )}
              </Paper>
              <Title order={3} mt="lg">
                操作记录
              </Title>
              <Paper withBorder>
                {data.audits.length ? (
                  data.audits.map((a: any) => (
                    <div className="record" key={a.id}>
                      <Text size="sm">
                        {a.actor} · {a.action}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {formatTime(a.created_at)} · {a.resource}
                      </Text>
                    </div>
                  ))
                ) : (
                  <Text p="lg" c="dimmed">
                    暂无操作记录
                  </Text>
                )}
              </Paper>
            </Stack>
          </Tabs.Panel>
        </Tabs>
        <Modal
          opened={confirmActivityClear}
          onClose={() => !busy && setConfirmActivityClear(false)}
          title="清理全部运行记录"
          centered
          closeOnClickOutside={false}
          closeOnEscape={!busy}
          withCloseButton={!busy}
          classNames={{
            content: 'admin-modal',
            header: 'admin-modal-header',
            body: 'admin-modal-body',
          }}
        >
          <Stack>
            <Text size="sm">
              将永久删除全部操作记录／审计日志和通知投递记录，包括当前列表未展示的历史记录。此操作无法撤销。
            </Text>
            <Alert color="orange" title="待发送通知也会删除">
              待发送和等待重试的通知将不再投递；已经开始发送的通知仍可能送达。清理后，新产生的记录会正常保存。
            </Alert>
            {activityClearError && <Alert color="red">{activityClearError}</Alert>}
            <Group justify="end">
              <Button
                variant="default"
                disabled={busy}
                data-autofocus
                onClick={() => setConfirmActivityClear(false)}
              >
                取消
              </Button>
              <Button color="red" loading={busy} onClick={clearActivity}>
                确认清理
              </Button>
            </Group>
          </Stack>
        </Modal>
        <Modal
          opened={!!edit}
          onClose={() => !busy && !testingChannel && setEdit(null)}
          title={`${edit?.id ? '编辑' : '新增'}${tabs.find((t) => t[0] === edit?.kind)?.[1] || ''}`}
          size="lg"
          closeOnClickOutside={false}
          centered
          classNames={{
            content: 'admin-modal',
            header: 'admin-modal-header',
            body: 'admin-modal-body',
          }}
        >
          <Stack>
            {error && <Alert color="red">{error}</Alert>}
            {edit?.kind !== 'events' && (
              <TextInput
                label="名称"
                value={draft.name || ''}
                onChange={(e) => patch('name', e.target.value)}
                required
              />
            )}
            {edit?.kind === 'groups' && (
              <NumberInput
                label="排序（越小越靠前）"
                min={0}
                value={draft.position}
                onChange={(v) => patch('position', v)}
              />
            )}
            {edit?.kind === 'components' && (
              <>
                <Textarea
                  label="服务说明"
                  value={draft.description}
                  onChange={(e) => patch('description', e.target.value)}
                />
                <Select
                  label="所属分组"
                  clearable
                  data={groupOptions}
                  value={draft.group_id}
                  onChange={(v) => patch('group_id', v)}
                />
                <TextInput
                  label="公开访问链接（可选）"
                  description="整个服务的统一访问入口，在公开页面显示“访问服务”。"
                  placeholder="https://example.com"
                  value={draft.link}
                  onChange={(e) => patch('link', e.target.value)}
                />
                <NumberInput
                  label="排序"
                  min={0}
                  value={draft.position}
                  onChange={(v) => patch('position', v)}
                />
                <Switch
                  label="在公开状态页展示"
                  checked={!!draft.public}
                  onChange={(e) => patch('public', e.currentTarget.checked ? 1 : 0)}
                />
              </>
            )}
            {edit?.kind === 'monitors' && (
              <>
                <Select
                  label="所属服务"
                  required
                  data={componentOptions}
                  value={draft.component_id}
                  onChange={(v) => patch('component_id', v)}
                />
                <TextInput
                  label="公开访问链接（可选）"
                  description="显示在监控标题右侧，与检测网址独立；留空不显示链接。"
                  placeholder="https://example.com"
                  value={draft.link ?? ''}
                  onChange={(e) => patch('link', e.target.value)}
                />
                <NumberInput
                  label="排序（越小越靠前）"
                  description="调整同一服务下的监控展示顺序；数值相同时保持原有顺序。"
                  min={0}
                  max={2147483647}
                  allowDecimal={false}
                  value={draft.position ?? 0}
                  onChange={(v) => patch('position', v === '' ? 0 : Number(v))}
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <Select
                    label="检测方式"
                    data={['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TCP_PING']}
                    value={draft.config?.method}
                    onChange={(v) => probe('method', v)}
                  />
                  <NumberInput
                    label="间隔（秒）"
                    min={data.policy?.minimumInterval || 60}
                    max={86400}
                    value={draft.interval}
                    onChange={(v) => patch('interval', v)}
                  />
                </SimpleGrid>
                <TextInput
                  label={draft.config?.method === 'TCP_PING' ? '主机:端口' : '检测网址'}
                  placeholder="https://example.com/health"
                  value={draft.config?.target}
                  onChange={(e) => probe('target', e.target.value)}
                  required
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <NumberInput
                    label="超时（毫秒）"
                    min={1000}
                    max={30000}
                    value={draft.config?.timeout}
                    onChange={(v) => probe('timeout', v)}
                  />
                  <NumberInput
                    label="报警宽限期（秒）"
                    min={0}
                    value={draft.grace}
                    onChange={(v) => patch('grace', v)}
                  />
                </SimpleGrid>
                <TextInput
                  label="期望状态码（逗号分隔，空白为 2xx）"
                  value={codes}
                  onChange={(e) => setCodes(e.target.value)}
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput
                    label="必须包含的关键词"
                    value={draft.config?.responseKeyword}
                    onChange={(e) => probe('responseKeyword', e.target.value)}
                  />
                  <TextInput
                    label="禁止出现的关键词"
                    value={draft.config?.responseForbiddenKeyword}
                    onChange={(e) => probe('responseForbiddenKeyword', e.target.value)}
                  />
                </SimpleGrid>
                <Textarea
                  label="请求头（JSON）"
                  description="敏感字段加密保存，不会出现在公开接口。"
                  className="monospace"
                  autosize
                  minRows={2}
                  value={headers}
                  onChange={(e) => setHeaders(e.target.value)}
                />
                <Textarea
                  label="请求体（可选）"
                  value={draft.config?.body}
                  onChange={(e) => probe('body', e.target.value)}
                />
                <Select
                  label="探测区域（尽力安排，不保证精确位置）"
                  data={[
                    { value: '', label: '默认 Cloudflare 节点' },
                    ...['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'].map(
                      (v) => ({ value: v, label: v })
                    ),
                  ]}
                  value={draft.config?.region}
                  onChange={(v) => probe('region', v)}
                />
                <Switch
                  label="区域探测不可用时回退默认节点"
                  checked={!!draft.config?.fallback}
                  onChange={(e) => probe('fallback', e.currentTarget.checked)}
                />
                <Switch
                  label="启用监控"
                  checked={!!draft.enabled}
                  onChange={(e) => patch('enabled', e.currentTarget.checked ? 1 : 0)}
                />
                <Switch
                  label="发送故障与恢复通知"
                  checked={!!draft.notify}
                  onChange={(e) => patch('notify', e.currentTarget.checked ? 1 : 0)}
                />
                <Text size="xs" c="dimmed">
                  HTTP
                  不自动跟随重定向，请填写最终健康检查地址；需要把重定向视为正常时可添加预期状态码。
                </Text>
              </>
            )}
            {edit?.kind === 'events' && (
              <>
                <TextInput
                  label="标题"
                  required
                  value={draft.title}
                  onChange={(e) => patch('title', e.target.value)}
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <Select
                    label="事件类型"
                    data={[
                      { value: 'incident', label: '故障事件' },
                      { value: 'maintenance', label: '计划维护' },
                    ]}
                    value={draft.kind}
                    onChange={(v) =>
                      setDraft((d: any) => ({
                        ...d,
                        kind: v,
                        status: v === 'maintenance' ? 'scheduled' : 'investigating',
                      }))
                    }
                  />
                  <Select
                    label="处理状态"
                    data={(draft.kind === 'maintenance'
                      ? maintenanceStatuses
                      : incidentStatuses
                    ).map((s) => ({ value: s, label: statusLabels[s] }))}
                    value={draft.status}
                    onChange={(v) =>
                      setDraft((d: any) => ({
                        ...d,
                        status: v,
                        end_at:
                          ['resolved', 'completed'].includes(v || '') && !d.end_at
                            ? Math.floor(Date.now() / 1000)
                            : d.end_at,
                      }))
                    }
                  />
                </SimpleGrid>
                <Select
                  label="影响程度"
                  data={[
                    { value: 'minor', label: '轻微影响' },
                    { value: 'major', label: '主要故障' },
                    { value: 'critical', label: '严重故障' },
                  ]}
                  value={draft.severity}
                  onChange={(v) => patch('severity', v)}
                />
                <MultiSelect
                  label="受影响服务"
                  maxValues={data.policy?.eventComponents || 100}
                  required
                  data={componentOptions}
                  value={draft.components || []}
                  onChange={(v) => patch('components', v)}
                />
                <MultiSelect
                  label="通知渠道"
                  description="仅列出启用渠道；只通知本次所选渠道，留空不发送通知。每次打开需重新选择。"
                  placeholder="选择通知渠道（可多选）"
                  comboboxProps={{ withinPortal: false }}
                  maxValues={data.policy?.maxChannels || 5}
                  data={data.channels
                    .filter((c: any) => c.enabled)
                    .map((c: any) => ({ value: c.id, label: c.name }))}
                  value={draft.notificationChannels || []}
                  onChange={(v) => patch('notificationChannels', v)}
                  clearable
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput
                    type="datetime-local"
                    label="实际开始时间（本地时区）"
                    value={draft.start_at ? localDate(draft.start_at) : ''}
                    onChange={(e) => patch('start_at', epoch(e.target.value))}
                  />
                  <TextInput
                    type="datetime-local"
                    label="结束 / 预计结束时间（可选）"
                    value={draft.end_at ? localDate(draft.end_at) : ''}
                    onChange={(e) => patch('end_at', e.target.value ? epoch(e.target.value) : null)}
                  />
                </SimpleGrid>
                <Textarea
                  label={edit.id ? '追加进展（保留已有时间线）' : '事件说明'}
                  description="支持 Markdown，禁止原始 HTML。"
                  autosize
                  minRows={5}
                  value={draft.body}
                  onChange={(e) => patch('body', e.target.value)}
                />
                {data.storage && (
                  <Button component="label" variant="light" loading={uploading}>
                    上传附件
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,application/pdf,text/plain"
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void upload(file)
                        e.target.value = ''
                      }}
                    />
                  </Button>
                )}
                {draft.body && (
                  <Paper withBorder p="md">
                    <Text size="xs" c="dimmed">
                      预览
                    </Text>
                    <div className="markdown">
                      <ReactMarkdown>{draft.body}</ReactMarkdown>
                    </div>
                  </Paper>
                )}
                <Switch
                  label="公开发布"
                  description="开启时公开发布，只有选择了通知渠道才发送通知；关闭时保存为草稿。"
                  checked={!!draft.published}
                  onChange={(e) => patch('published', e.currentTarget.checked ? 1 : 0)}
                />
                {draft.updates?.length > 0 && (
                  <>
                    <Divider label="已有进展" />
                    <Timeline event={draft} admin />
                  </>
                )}
              </>
            )}
            {edit?.kind === 'channels' && (
              <>
                <Switch
                  label="启用发送"
                  checked={!!draft.enabled}
                  onChange={(e) => patch('enabled', e.currentTarget.checked ? 1 : 0)}
                />
                <Textarea
                  label="Webhook 配置（JSON）"
                  description={
                    edit.id
                      ? '已显示保存的完整配置，可直接修改；留空保留已有配置。'
                      : '使用 $MSG 作为消息占位符。支持 json / param / x-www-form-urlencoded。'
                  }
                  className="monospace"
                  autosize
                  minRows={8}
                  styles={{
                    input: {
                      fontFamily:
                        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                    },
                  }}
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                />
                <Text size="xs" c="dimmed">
                  测试会用已保存配置真实发送一条测试消息，即使渠道已停用；仅发送一次，不自动重试。修改配置后请先保存，再打开测试。
                </Text>
                <Button
                  variant="light"
                  loading={testingChannel}
                  disabled={
                    !edit.id ||
                    busy ||
                    (!!channel.trim() && channel.trim() !== JSON.stringify(draft.config, null, 2))
                  }
                  onClick={testChannel}
                >
                  发送测试通知
                </Button>
                {!edit.id && (
                  <Text size="xs" c="dimmed">
                    请先保存渠道，再进行测试。
                  </Text>
                )}
                {channelTest && (
                  <Alert
                    color={channelTest.ok ? 'teal' : 'red'}
                    title={channelTest.ok ? '测试请求成功' : '测试失败'}
                  >
                    <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {channelTest.log}
                    </Text>
                    {channelTest.elapsedMs !== undefined && (
                      <Text size="xs" mt="xs">
                        耗时：{channelTest.elapsedMs} ms
                      </Text>
                    )}
                  </Alert>
                )}
              </>
            )}
            <Group justify="end" mt="md" className="admin-editor-actions">
              <Button
                variant="default"
                disabled={busy || testingChannel}
                onClick={() => setEdit(null)}
              >
                取消
              </Button>
              <Button loading={busy} disabled={uploading || testingChannel} onClick={save}>
                保存
              </Button>
            </Group>
          </Stack>
        </Modal>
        <footer className="admin-footer">
          <Text size="xs" c="dimmed">
            配置保存到 Cloudflare D1 · 公告不需要重新部署
          </Text>
        </footer>
      </Container>
    </div>
  )
}
