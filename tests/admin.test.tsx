// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import Admin from '../src/admin'
const { api, downloadKey } = vi.hoisted(() => ({ api: vi.fn(), downloadKey: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  request: api,
  downloadEncryptionKey: downloadKey,
}))
const overview = {
  actor: 'tester',
  groups: [],
  components: [{ id: 'service', name: '测试服务' }],
  monitors: [],
  events: [],
  channels: [],
  settings: { title: 'Test', description: '' },
  deliveries: [],
  audits: [],
  storage: false,
}
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Element.prototype.scrollIntoView = vi.fn()
  api.mockReset()
  downloadKey.mockReset()
  downloadKey.mockResolvedValue(undefined)
  api.mockImplementation(async (path: string) =>
    path === '/api/admin/overview' ? structuredClone(overview) : { id: 'new' }
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
function start() {
  render(
    <MantineProvider>
      <Admin />
    </MantineProvider>
  )
}
it('distinguishes health from enabled state and displays valid current or historical detection times', async () => {
  const at = Math.floor(Date.now() / 1000)
  const base = {
    component_id: 'service',
    enabled: 1,
    interval: 60,
    version: 2,
    result_version: 2,
    checked_at: at,
    status: 'up',
    latency: 125,
  }
  api.mockResolvedValue({
    ...structuredClone(overview),
    monitors: [
      { ...base, id: 'healthy', name: '正常监控', latency: 0 },
      { ...base, id: 'failed', name: '异常监控', status: 'down', latency: 30000 },
      {
        ...base,
        id: 'new',
        name: '未检测',
        checked_at: null,
        result_version: null,
        latency: null,
        status: null,
      },
      { ...base, id: 'changed', name: '配置变更', result_version: 1 },
      { ...base, id: 'stale', name: '过期结果', checked_at: at - 200 },
      { ...base, id: 'paused', name: '暂停监控', enabled: 0 },
      { ...base, id: 'invalid', name: '无耗时数据', latency: null },
    ],
  })
  start()
  const healthy = within(await screen.findByRole('group', { name: '正常监控 检测结果' }))
  expect(healthy.getByText('正常')).toBeTruthy()
  expect(healthy.getByText('响应时间')).toBeTruthy()
  expect(healthy.getByText('0')).toBeTruthy()
  const failed = within(screen.getByRole('group', { name: '异常监控 检测结果' }))
  expect(failed.getByText('异常')).toBeTruthy()
  expect(failed.getByText('检测耗时')).toBeTruthy()
  expect(failed.getByText('30,000')).toBeTruthy()
  expect(failed.getByText('失败检测')).toBeTruthy()
  for (const name of ['未检测', '配置变更']) {
    const group = within(screen.getByRole('group', { name: `${name} 检测结果` }))
    expect(group.getByText('待检测')).toBeTruthy()
    expect(group.getByText('—')).toBeTruthy()
    expect(group.queryByText('正常')).toBeNull()
  }
  const stale = within(screen.getByRole('group', { name: '过期结果 检测结果' }))
  expect(stale.getByText('数据过期')).toBeTruthy()
  expect(stale.getByText('上次检测')).toBeTruthy()
  const paused = within(screen.getByRole('group', { name: '暂停监控 检测结果' }))
  expect(paused.getByText('已暂停')).toBeTruthy()
  expect(paused.getByText('125')).toBeTruthy()
  expect(paused.getByText('上次检测')).toBeTruthy()
  expect(
    within(screen.getByRole('group', { name: '无耗时数据 检测结果' })).getByText('—')
  ).toBeTruthy()
})

it('requires confirmation to clear activity and leaves records intact when cancelled', async () => {
  api.mockResolvedValue({
    ...structuredClone(overview),
    audits: [
      { id: 'a1', actor: 'tester', action: 'channel.test', resource: 'hook', created_at: 1 },
    ],
  })
  start()
  fireEvent.click(await screen.findByRole('tab', { name: '运行记录' }))
  fireEvent.click(screen.getByRole('button', { name: '一键清理' }))
  const dialog = await screen.findByRole('dialog', { name: '清理全部运行记录' })
  expect(within(dialog).getByText('待发送通知也会删除')).toBeTruthy()
  expect(api.mock.calls.some(([path]) => path === '/api/admin/activity/clear')).toBe(false)
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(api.mock.calls.some(([path]) => path === '/api/admin/activity/clear')).toBe(false)
  expect(screen.getByText('tester · channel.test')).toBeTruthy()
})

it('clears confirmed activity and refreshes both lists', async () => {
  let cleared = false
  api.mockImplementation(async (path: string) => {
    if (path === '/api/admin/activity/clear') {
      cleared = true
      return { ok: true, deleted: { deliveries: 130, audits: 140 } }
    }
    return {
      ...structuredClone(overview),
      deliveries: cleared ? [] : [{ id: 'd1', state: 'failed', attempts: 5, created_at: 1 }],
      audits: cleared
        ? []
        : [{ id: 'a1', actor: 'tester', action: 'channel.test', resource: 'hook', created_at: 1 }],
    }
  })
  start()
  fireEvent.click(await screen.findByRole('tab', { name: '运行记录' }))
  fireEvent.click(screen.getByRole('button', { name: '一键清理' }))
  const dialog = await screen.findByRole('dialog', { name: '清理全部运行记录' })
  fireEvent.click(within(dialog).getByRole('button', { name: '确认清理' }))
  expect(await screen.findByText('已清理 130 条通知投递记录和 140 条操作记录')).toBeTruthy()
  expect(api).toHaveBeenCalledWith('/api/admin/activity/clear', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  })
  expect(screen.getByText('暂无投递记录')).toBeTruthy()
  expect(screen.getByText('暂无操作记录')).toBeTruthy()
  expect(api.mock.calls.filter(([path]) => path === '/api/admin/overview')).toHaveLength(2)
})

it('keeps the confirmation dialog open with an error when clearing fails', async () => {
  api.mockImplementation(async (path: string) => {
    if (path === '/api/admin/activity/clear') throw new Error('清理暂时不可用')
    return structuredClone(overview)
  })
  start()
  fireEvent.click(await screen.findByRole('tab', { name: '运行记录' }))
  fireEvent.click(screen.getByRole('button', { name: '一键清理' }))
  const dialog = await screen.findByRole('dialog', { name: '清理全部运行记录' })
  fireEvent.click(within(dialog).getByRole('button', { name: '确认清理' }))
  expect(await within(dialog).findByText('清理暂时不可用')).toBeTruthy()
  expect(api.mock.calls.filter(([path]) => path === '/api/admin/overview')).toHaveLength(1)
  expect(
    (within(dialog).getByRole('button', { name: '确认清理' }) as HTMLButtonElement).disabled
  ).toBe(false)
})

it('previews, validates, saves and restores notification templates in settings', async () => {
  start()
  fireEvent.click(await screen.findByRole('tab', { name: '页面设置' }))
  const input = screen.getByLabelText('检测异常模板')
  expect(screen.getByLabelText('公告发布 / 更新预览').textContent).toContain('调查中')
  fireEvent.change(screen.getByLabelText('通知时区'), { target: { value: 'Asia/Shanghai' } })
  expect(screen.getByLabelText('检测恢复预览').textContent).toContain(
    '2026-09-22 16:00:00 UTC+08:00'
  )
  fireEvent.change(input, { target: { value: '故障 {{monitorName}}：{{reason}}' } })
  expect(screen.getByLabelText('检测异常预览').textContent).toBe('故障 网站首页：HTTP 503')
  fireEvent.click(screen.getByRole('button', { name: '保存通知模板' }))
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/api/admin/settings/notification-templates',
      expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('故障 {{monitorName}}：{{reason}}'),
      })
    )
  )
  fireEvent.change(input, { target: { value: '{{unknown}}' } })
  const saved = api.mock.calls.find(
    (call) => call[0] === '/api/admin/settings/notification-templates'
  )!
  expect(JSON.parse(saved[1].body).timeZone).toBe('Asia/Shanghai')
  expect((screen.getByRole('button', { name: '保存通知模板' }) as HTMLButtonElement).disabled).toBe(
    true
  )
  fireEvent.click(screen.getByRole('button', { name: '恢复检测异常默认模板' }))
  expect((input as HTMLTextAreaElement).value).toBe(
    '🔴 检测异常 · {{monitorName}}\n{{reason}}\n{{time}}'
  )
  fireEvent.change(screen.getByLabelText('通知时区'), { target: { value: 'Invalid/Zone' } })
  expect((screen.getByRole('button', { name: '保存通知模板' }) as HTMLButtonElement).disabled).toBe(
    true
  )
})
it('only offers key backup when enabled and downloads after the administrator clicks', async () => {
  api.mockResolvedValue({ ...structuredClone(overview), keyExportEnabled: true })
  start()
  fireEvent.click(await screen.findByRole('tab', { name: '页面设置' }))
  expect(downloadKey).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '下载密钥备份' }))
  expect(await screen.findByText(/已发起密钥备份下载/)).toBeTruthy()
  expect(downloadKey).toHaveBeenCalledTimes(1)
})
it('hides key backup when disabled', async () => {
  start()
  fireEvent.click(await screen.findByRole('tab', { name: '页面设置' }))
  expect(screen.queryByRole('button', { name: '下载密钥备份' })).toBeNull()
})
it('sends the current unsaved template to the selected channel and shows its result', async () => {
  api.mockImplementation(async (path: string) =>
    path === '/api/admin/overview'
      ? {
          ...structuredClone(overview),
          channels: [{ id: 'hook', name: '微信测试', enabled: 0, version: 1 }],
        }
      : { ok: false, log: '接收端返回 HTTP 429', elapsedMs: 25 }
  )
  start()
  fireEvent.click(await screen.findByRole('tab', { name: '页面设置' }))
  fireEvent.change(screen.getByLabelText('检测异常模板'), {
    target: { value: '未保存 {{monitorName}}' },
  })
  fireEvent.click(screen.getByRole('textbox', { name: '测试通知渠道' }))
  fireEvent.click(await screen.findByRole('option', { name: '微信测试（已停用）' }))
  expect(screen.getByLabelText('测试消息预览').textContent).toContain('未保存 网站首页')
  fireEvent.click(screen.getByRole('button', { name: '发送模板测试通知' }))
  expect(await screen.findByText('接收端返回 HTTP 429')).toBeTruthy()
  const calls = api.mock.calls.filter((call) => call[0] === '/api/admin/channels/hook/test')
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0][1].body)).toMatchObject({
    scenario: 'down',
    templates: { down: '未保存 {{monitorName}}' },
  })
  expect(
    api.mock.calls.some((call) => call[0] === '/api/admin/settings/notification-templates')
  ).toBe(false)
})
it('shows channel test failures inside the editor', async () => {
  api.mockImplementation(async (path: string) =>
    path === '/api/admin/overview'
      ? {
          ...structuredClone(overview),
          channels: [{ id: 'hook', name: '测试渠道', enabled: 0, version: 1 }],
        }
      : path === '/api/admin/channels/hook'
      ? {
          id: 'hook',
          name: '测试渠道',
          enabled: 0,
          version: 1,
          config: { url: 'https://example.com/hook', payload: { text: '$MSG' } },
        }
      : { ok: false, log: '接收端返回 HTTP 401', elapsedMs: 120 }
  )
  start()
  fireEvent.click(await screen.findByRole('tab', { name: '通知渠道' }))
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '发送测试通知' }))
  expect(await within(dialog).findByText('接收端返回 HTTP 401')).toBeTruthy()
  expect(api).toHaveBeenCalledWith('/api/admin/channels/hook/test', { method: 'POST' })
  expect(within(dialog).getByText('耗时：120 ms')).toBeTruthy()
})
it('loads saved channel secrets, saves edits and displays them when reopened', async () => {
  let saved = {
    id: 'hook',
    name: '测试渠道',
    enabled: 1,
    version: 3,
    config: {
      url: 'https://example.com/hook?key=test-secret',
      method: 'POST',
      headers: { Authorization: 'Bearer test-secret' },
      payloadType: 'json',
      payload: { text: '$MSG' },
      timeout: 10000,
    },
  }
  api.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
    if (path === '/api/admin/overview') {
      const { config: _, ...channel } = saved
      return { ...structuredClone(overview), channels: [channel] }
    }
    if (path === '/api/admin/channels/hook') {
      if (options?.method === 'PUT') {
        saved = { ...JSON.parse(options.body!), version: saved.version + 1 }
        return { ok: true }
      }
      return structuredClone(saved)
    }
    return { ok: true }
  })
  start()
  fireEvent.click(await screen.findByRole('tab', { name: '通知渠道' }))
  expect(api).not.toHaveBeenCalledWith('/api/admin/channels/hook')
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  const dialog = await screen.findByRole('dialog')
  const input = within(dialog).getByLabelText('Webhook 配置（JSON）') as HTMLTextAreaElement
  expect(JSON.parse(input.value)).toEqual(saved.config)
  const testButton = within(dialog).getByRole('button', {
    name: '发送测试通知',
  }) as HTMLButtonElement
  expect(testButton.disabled).toBe(false)
  const updated = { ...saved.config, timeout: 5000 }
  fireEvent.change(input, { target: { value: JSON.stringify(updated, null, 2) } })
  expect(testButton.disabled).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const put = api.mock.calls.find((call) => call[1]?.method === 'PUT')!
  expect(JSON.parse(put[1].body)).toMatchObject({ version: 3, config: updated })
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  const reopened = await screen.findByRole('dialog')
  expect(
    JSON.parse(
      (within(reopened).getByLabelText('Webhook 配置（JSON）') as HTMLTextAreaElement).value
    )
  ).toEqual(updated)
  expect(
    (within(reopened).getByRole('button', { name: '发送测试通知' }) as HTMLButtonElement).disabled
  ).toBe(false)
})
it('selects only enabled channels for the current event save and clears them when reopened', async () => {
  api.mockImplementation(async (path: string) =>
    path === '/api/admin/overview'
      ? {
          ...structuredClone(overview),
          channels: [
            { id: 'one', name: '邮件通知', enabled: 1 },
            { id: 'two', name: '微信通知', enabled: 1 },
            { id: 'disabled', name: '停用通知', enabled: 0 },
          ],
          events: [
            {
              id: 'event',
              kind: 'incident',
              title: '故障公告',
              status: 'investigating',
              severity: 'minor',
              start_at: 100,
              end_at: null,
              published: 1,
              version: 1,
              components: ['service'],
              updates: [],
            },
          ],
        }
      : { ok: true }
  )
  start()
  fireEvent.click(await screen.findByRole('tab', { name: '公告与维护' }))
  fireEvent.click(screen.getByRole('button', { name: '新增' }))
  let dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('textbox', { name: '通知渠道' }))
  expect(
    (await screen.findByRole('option', { name: '邮件通知' })).getAttribute('aria-selected')
  ).toBe('false')
  expect(screen.queryByRole('option', { name: '停用通知' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: '更新' }))
  dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('textbox', { name: '通知渠道' }))
  fireEvent.click(await screen.findByRole('option', { name: '邮件通知' }))
  fireEvent.click(await screen.findByRole('option', { name: '微信通知' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const first = api.mock.calls.find((call) => call[0] === '/api/admin/events/event')!
  expect(JSON.parse(first[1].body).notificationChannels).toEqual(['one', 'two'])
  fireEvent.click(screen.getByRole('button', { name: '更新' }))
  dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
  await waitFor(() =>
    expect(api.mock.calls.filter((call) => call[0] === '/api/admin/events/event')).toHaveLength(2)
  )
  const second = api.mock.calls.filter((call) => call[0] === '/api/admin/events/event')[1]
  expect(JSON.parse(second[1].body).notificationChannels).toEqual([])
})
it('creates a group using the visible management form', async () => {
  start()
  await screen.findByRole('tab', { name: '分组' })
  fireEvent.click(screen.getByRole('tab', { name: '分组' }))
  fireEvent.click(screen.getByRole('button', { name: '新增' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('名称', { exact: false }), {
    target: { value: '同学的服务器' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/api/admin/groups',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('同学的服务器') })
    )
  )
  expect(await screen.findByText('已保存。公开页面会在下一次刷新时显示更新。')).toBeTruthy()
})
it('sends monitor edits with the original version and parsed headers', async () => {
  const config = {
    target: 'https://example.com',
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
  api.mockImplementation(async (path: string) =>
    path === '/api/admin/overview'
      ? {
          ...structuredClone(overview),
          monitors: [
            {
              id: 'probe',
              name: '网站监控',
              component_id: 'service',
              position: 10,
              enabled: 1,
              interval: 60,
              grace: 180,
              notify: 1,
              version: 7,
              probeSummary: { method: config.method, target: config.target },
            },
          ],
        }
      : {
          id: 'probe',
          name: '网站监控',
          component_id: 'service',
          position: 10,
          enabled: 1,
          interval: 60,
          grace: 180,
          notify: 1,
          version: 7,
          config,
        }
  )
  start()
  expect(await screen.findByText(/GET https:\/\/example.com/)).toBeTruthy()
  expect(api).not.toHaveBeenCalledWith('/api/admin/monitors/probe')
  fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
  const dialog = await screen.findByRole('dialog')
  expect(api).toHaveBeenCalledWith('/api/admin/monitors/probe')
  fireEvent.change(within(dialog).getByLabelText('排序（越小越靠前）'), {
    target: { value: '20' },
  })
  fireEvent.change(within(dialog).getByLabelText('检测网址', { exact: false }), {
    target: { value: 'https://example.org/health' },
  })
  fireEvent.change(within(dialog).getByLabelText('请求头（JSON）'), {
    target: { value: '{"X-Test":"yes"}' },
  })
  fireEvent.change(within(dialog).getByLabelText('公开访问链接（可选）'), {
    target: { value: 'https://example.org/home' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/api/admin/monitors/probe',
      expect.objectContaining({ method: 'PUT' })
    )
  )
  const value = JSON.parse(
    api.mock.calls.find((c) => c[0] === '/api/admin/monitors/probe' && c[1]?.method === 'PUT')![1]
      .body
  )
  expect(value.version).toBe(7)
  expect(value.position).toBe(20)
  expect(value.link).toBe('https://example.org/home')
  expect(value.config.target).toBe('https://example.org/health')
  expect(value.config.headers).toEqual({ 'X-Test': 'yes' })
})
