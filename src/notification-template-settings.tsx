import { useRef, useState } from 'react'
import { request } from './api'
import { statusLabels } from '../shared/models'
import {
  Alert,
  Button,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core'
import {
  defaultNotificationTemplates,
  notificationSeverityLabels,
  notificationKindLabels,
  notificationTemplateFields,
  notificationTemplateKinds,
  notificationTemplateLabels,
  notificationTemplateError,
  renderNotificationTemplate,
  formatNotificationTime,
  isNotificationTimeZone,
  templateLimit,
  type NotificationTemplates,
  renderNotificationTest,
  type NotificationTestScenario,
} from '../shared/notification-templates'

const example = {
  monitorName: '网站首页',
  reason: 'HTTP 503',
  time: '2026-09-22T08:00:00.000Z',
  startTime: '2026-09-22T08:00:00.000Z',
  endTime: '待定',
  title: '网站访问异常',
  kind: notificationKindLabels.incident,
  status: statusLabels.investigating,
  severity: notificationSeverityLabels.major,
  services: '网站首页、用户中心、支付服务',
  body: '我们正在排查问题，将持续更新进展。',
}

export default function NotificationTemplateSettings({
  value,
  channels = [],
  busy,
  onSave,
}: {
  value?: NotificationTemplates
  channels?: { id: string; name: string; enabled: number }[]
  busy: boolean
  onSave: (value: NotificationTemplates) => Promise<unknown>
}) {
  const [draft, setDraft] = useState<NotificationTemplates>({
    ...defaultNotificationTemplates,
    ...value,
  })
  const [testChannel, setTestChannel] = useState<string | null>(null)
  const [scenario, setScenario] = useState<NotificationTestScenario>('down')
  const [testing, setTesting] = useState(false)
  const sending = useRef(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    log: string
    elapsedMs?: number
  } | null>(null)
  const [sampleTime] = useState(() => Math.floor(Date.now() / 1000))
  const errors = notificationTemplateKinds.map((kind) =>
    notificationTemplateError(kind, draft[kind])
  )
  const validTimeZone = isNotificationTimeZone(draft.timeZone.trim())
  const invalid = errors.some(Boolean) || !validTimeZone
  const previewTime = validTimeZone
    ? formatNotificationTime(Date.parse(example.time) / 1000, draft.timeZone.trim())
    : '请选择有效时区'
  return (
    <Paper withBorder p="xl" mt="lg">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!invalid) void onSave({ ...draft, timeZone: draft.timeZone.trim() })
        }}
      >
        <Stack>
          <Title order={3}>通知正文模板</Title>
          <Text size="sm" c="dimmed">
            生成 Webhook 的 $MSG 正文。保存后用于所有渠道的新通知；已入队消息和手动测试通知不变。
            公告发布与更新共用模板，正文变量为本次提交的进展，未填写时为空。预览使用示例数据，不发送消息。
          </Text>
          <TextInput
            label="通知时区"
            description="适用于所有通知模板的时间变量，自动处理夏令时。例如 Asia/Shanghai 为北京时间。UTC 保留原有 ISO 格式。"
            list="notification-time-zones"
            value={draft.timeZone}
            onChange={(event) => setDraft({ ...draft, timeZone: event.currentTarget.value })}
            error={!validTimeZone ? '请输入有效时区，例如 Asia/Shanghai 或 UTC' : null}
          />
          <datalist id="notification-time-zones">
            {[
              'UTC',
              'Asia/Shanghai',
              'Asia/Hong_Kong',
              'Asia/Tokyo',
              'Europe/London',
              'America/New_York',
              'America/Los_Angeles',
            ].map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          {notificationTemplateKinds.map((kind) => (
            <Stack key={kind} gap="xs">
              <Textarea
                label={`${notificationTemplateLabels[kind]}模板`}
                description={Object.entries(notificationTemplateFields[kind])
                  .map(([key, label]) => `{{${key}}}：${label}`)
                  .join('\n')}
                styles={{
                  description: {
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    lineHeight: 1.8,
                    marginTop: 4,
                    marginBottom: 8,
                  },
                }}
                value={draft[kind]}
                onChange={(event) => setDraft({ ...draft, [kind]: event.currentTarget.value })}
                error={notificationTemplateError(kind, draft[kind])}
                maxLength={templateLimit}
                autosize
                minRows={3}
              />
              <Group justify="space-between">
                <Text size="sm" c="dimmed">
                  示例预览
                </Text>
                <Button
                  type="button"
                  size="xs"
                  variant="subtle"
                  onClick={() => setDraft({ ...draft, [kind]: defaultNotificationTemplates[kind] })}
                >
                  恢复{notificationTemplateLabels[kind]}默认模板
                </Button>
              </Group>
              <Paper
                withBorder
                p="sm"
                aria-label={`${notificationTemplateLabels[kind]}预览`}
                style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {renderNotificationTemplate(draft[kind], {
                  ...example,
                  time: previewTime,
                  startTime: previewTime,
                })}
              </Paper>
            </Stack>
          ))}
          <Button type="submit" loading={busy} disabled={invalid}>
            保存通知模板
          </Button>
          <Title order={4}>真实模板测试</Title>
          <Text size="sm" c="dimmed">
            使用当前编辑的模板和时区，无需先保存；发送至所选渠道的已保存 Webhook。
            停用渠道也可测试。消息带测试标识，只发送一次，不入队、不重试、不创建公告。
          </Text>
          {!channels.length && <Alert color="yellow">请先在“通知渠道”中添加并保存一个渠道。</Alert>}
          <Select
            label="测试通知渠道"
            placeholder="请选择渠道"
            value={testChannel}
            data={channels.map((channel) => ({
              value: channel.id,
              label: `${channel.name}${channel.enabled ? '' : '（已停用）'}`,
            }))}
            onChange={(value) => {
              setTestChannel(value)
              setTestResult(null)
            }}
            disabled={testing}
          />
          <Select
            label="测试消息类型"
            value={scenario}
            disabled={testing}
            data={[
              { value: 'down', label: '检测异常' },
              { value: 'recovery', label: '检测恢复' },
              { value: 'incident', label: '故障公告' },
              { value: 'maintenance', label: '维护公告' },
            ]}
            onChange={(value) => {
              if (value) setScenario(value as NotificationTestScenario)
              setTestResult(null)
            }}
          />
          {!invalid && (
            <Paper
              withBorder
              p="sm"
              aria-label="测试消息预览"
              style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            >
              {renderNotificationTest(
                { ...draft, timeZone: draft.timeZone.trim() },
                scenario,
                sampleTime
              )}
            </Paper>
          )}
          <Text size="xs" c="dimmed">
            发送时使用当前时间替换预览中的示例时间。
          </Text>
          <Button
            type="button"
            variant="light"
            loading={testing}
            disabled={busy || invalid || !channels.some((c) => c.id === testChannel)}
            onClick={async () => {
              if (sending.current || !testChannel) return
              sending.current = true
              setTesting(true)
              setTestResult(null)
              try {
                setTestResult(
                  await request(`/api/admin/channels/${testChannel}/test`, {
                    method: 'POST',
                    body: JSON.stringify({
                      templates: { ...draft, timeZone: draft.timeZone.trim() },
                      scenario,
                    }),
                  })
                )
              } catch (error) {
                setTestResult({ ok: false, log: (error as Error).message })
              } finally {
                sending.current = false
                setTesting(false)
              }
            }}
          >
            发送模板测试通知
          </Button>
          {testResult && (
            <Alert
              color={testResult.ok ? 'green' : 'red'}
              title={testResult.ok ? '测试请求成功' : '测试发送失败'}
            >
              <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {testResult.log}
              </Text>
              {testResult.elapsedMs !== undefined && (
                <Text size="xs">耗时：{testResult.elapsedMs} ms</Text>
              )}
            </Alert>
          )}
        </Stack>
      </form>
    </Paper>
  )
}
