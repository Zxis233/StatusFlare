// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { act, render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { MantineProvider } from '@mantine/core'
import PublicPage from '../src/public'
const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  request: api,
}))
vi.mock('react-chartjs-2', () => ({
  Line: ({ data }: any) => <div data-testid="history-chart">{data.datasets[0].data.join(',')}</div>,
}))
function statusData(checkedAt: number | null = null) {
  return {
    settings: { title: 'Status', description: '' },
    groups: [{ id: 'public', name: 'Public' }],
    components: [
      {
        id: 'blog',
        name: 'Blog',
        group_id: 'public',
        description: '',
        link: 'https://example.com/',
      },
    ],
    monitors: ['Homepage', 'Comment'].map((name) => ({
      id: name,
      name,
      component_id: 'blog',
      status: 'unknown',
      checked_at: checkedAt,
      latency: null,
      history: [],
      link: name === 'Homepage' ? 'https://example.org/home' : '',
    })),
    events: [],
    now: 1700000000,
  }
}
function detail(latency: number) {
  return { daily: [], samples: [{ checked_at: 1700000000, up: 1, latency }], outages: [] }
}
function historyCalls(id: string) {
  return api.mock.calls.filter(([path]) => path === `/api/monitors/${id}/history`).length
}
function start(strict = false) {
  const page = (
    <MantineProvider
      theme={{ components: { Accordion: { defaultProps: { transitionDuration: 0 } } } }}
    >
      <PublicPage />
    </MantineProvider>
  )
  render(strict ? <StrictMode>{page}</StrictMode> : page)
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
  api.mockReset()
  api.mockImplementation(async (path: string) =>
    path === '/api/status' ? statusData() : { daily: [], samples: [], outages: [] }
  )
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('reuses loaded histories across repeated expansions and deduplicates StrictMode requests', async () => {
  api.mockImplementation(async (path: string) =>
    path === '/api/status' ? statusData() : detail(path.includes('Homepage') ? 125 : 250)
  )
  start(true)
  const control = await screen.findByRole('button', { name: /Blog/ })
  expect(historyCalls('Homepage')).toBe(0)
  fireEvent.click(control)
  await screen.findByText('125')
  await screen.findByText('250')
  fireEvent.click(control)
  fireEvent.click(control)
  expect(screen.getByText('125')).toBeTruthy()
  expect(screen.getByText('250')).toBeTruthy()
  expect(historyCalls('Homepage')).toBe(1)
  expect(historyCalls('Comment')).toBe(1)
})

it('shares an in-flight history request when the service is collapsed and reopened', async () => {
  let resolve!: (value: ReturnType<typeof detail>) => void
  const pending = new Promise<ReturnType<typeof detail>>((done) => {
    resolve = done
  })
  api.mockImplementation((path: string) =>
    path === '/api/status'
      ? Promise.resolve(statusData())
      : path.includes('Homepage')
      ? pending
      : Promise.resolve(detail(250))
  )
  start()
  const control = await screen.findByRole('button', { name: /Blog/ })
  fireEvent.click(control)
  fireEvent.click(control)
  fireEvent.click(control)
  expect(historyCalls('Homepage')).toBe(1)
  await act(async () => {
    resolve(detail(125))
  })
  expect(await screen.findByText('125')).toBeTruthy()
})

it('only reloads details when their check time changes and stays lazy while collapsed', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let checkedAt = 1700000000
  api.mockImplementation(async (path: string) =>
    path === '/api/status'
      ? {
          ...statusData(),
          monitors: statusData().monitors.map((m) => ({
            ...m,
            checked_at: m.id === 'Homepage' ? checkedAt : null,
          })),
        }
      : detail(path.includes('Homepage') ? checkedAt - 1699999900 : 250)
  )
  start()
  const control = await screen.findByRole('button', { name: /Blog/ })
  fireEvent.click(control)
  await screen.findByText('100')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000)
  })
  expect(historyCalls('Homepage')).toBe(1)
  checkedAt++
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000)
  })
  expect(await screen.findByText('101')).toBeTruthy()
  expect(historyCalls('Homepage')).toBe(2)
  expect(historyCalls('Comment')).toBe(1)
  fireEvent.click(control)
  checkedAt++
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000)
  })
  expect(historyCalls('Homepage')).toBe(2)
  fireEvent.click(control)
  expect(await screen.findByText('102')).toBeTruthy()
  expect(historyCalls('Homepage')).toBe(3)
})

it('discards a late old history response without overwriting or evicting the newer cache', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let checkedAt = 1700000000
  let resolveOld!: (value: ReturnType<typeof detail>) => void
  const old = new Promise<ReturnType<typeof detail>>((done) => {
    resolveOld = done
  })
  api.mockImplementation((path: string) =>
    path === '/api/status'
      ? Promise.resolve(statusData(checkedAt))
      : path.includes('Homepage') && checkedAt === 1700000000
      ? old
      : Promise.resolve(detail(path.includes('Homepage') ? 200 : 250))
  )
  start()
  const control = await screen.findByRole('button', { name: /Blog/ })
  fireEvent.click(control)
  checkedAt++
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000)
  })
  expect(await screen.findByText('200')).toBeTruthy()
  await act(async () => {
    resolveOld(detail(111))
  })
  expect(screen.queryByText('111')).toBeNull()
  fireEvent.click(control)
  fireEvent.click(control)
  expect(screen.getByText('200')).toBeTruthy()
  expect(historyCalls('Homepage')).toBe(2)
})

it('retries failed histories and clears the previous error after reopening', async () => {
  let failed = true
  api.mockImplementation(async (path: string) => {
    if (path === '/api/status') return statusData()
    if (path.includes('Homepage') && failed) throw new Error('历史读取失败')
    return detail(path.includes('Homepage') ? 125 : 250)
  })
  start()
  const control = await screen.findByRole('button', { name: /Blog/ })
  fireEvent.click(control)
  await screen.findByText('历史读取失败')
  failed = false
  fireEvent.click(control)
  fireEvent.click(control)
  await screen.findByText('125')
  expect(screen.queryByText('历史读取失败')).toBeNull()
  expect(historyCalls('Homepage')).toBe(2)
  expect(historyCalls('Comment')).toBe(1)
})

it('drops cached details when a monitor stops being public', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let visible = true
  api.mockImplementation(async (path: string) =>
    path === '/api/status'
      ? { ...statusData(), monitors: visible ? statusData().monitors : [] }
      : detail(125)
  )
  start()
  fireEvent.click(await screen.findByRole('button', { name: /Blog/ }))
  await waitFor(() => expect(screen.getAllByTestId('history-chart')).toHaveLength(2))
  visible = false
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000)
  })
  visible = true
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000)
  })
  await waitFor(() => expect(screen.getAllByTestId('history-chart')).toHaveLength(2))
  expect(historyCalls('Homepage')).toBe(2)
})
it('shows the optional monitor URL beside its title and retains the service entry', async () => {
  start()
  fireEvent.click(await screen.findByRole('button', { name: /Blog/ }))
  const link = await screen.findByRole('link', { name: 'https://example.org/home ↗' })
  expect(link.getAttribute('href')).toBe('https://example.org/home')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toContain('noopener')
  expect(within(screen.getByText('Homepage').parentElement!).getByRole('link')).toBe(link)
  expect(within(screen.getByText('Comment').parentElement!).queryByRole('link')).toBeNull()
  expect(screen.getByRole('link', { name: '访问服务 ↗' }).getAttribute('href')).toBe(
    'https://example.com/'
  )
})
