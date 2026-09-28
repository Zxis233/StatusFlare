// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { downloadEncryptionKey } from '../src/api'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn())
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:key-backup'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('saves the response as a file without putting the key in the page', async () => {
  const blob = new Blob(['ENCRYPTION_KEY=test-fixture-only\n'])
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    headers: new Headers({ 'content-type': 'application/octet-stream' }),
    blob: async () => blob,
  } as Response)
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    expect(this.download).toBe('statusflare-encryption-key.env')
    expect(this.getAttribute('href')).toBe('blob:key-backup')
  })
  await downloadEncryptionKey()
  expect(click).toHaveBeenCalledTimes(1)
  expect(URL.createObjectURL).toHaveBeenCalledWith(blob)
  const [path, options] = vi.mocked(fetch).mock.calls[0]
  expect(path).toBe('/api/admin/encryption-key/export')
  expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' })
  expect(new Headers(options?.headers).get('x-statusflare-key-export')).toBe('1')
  expect(document.body.textContent).not.toContain('test-fixture-only')
  expect(document.querySelector('a[download]')).toBeNull()
  vi.runAllTimers()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:key-backup')
})
it('does not download an Access login page or a server error', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    headers: new Headers({ 'content-type': 'text/html' }),
  } as Response)
  await expect(downloadEncryptionKey()).rejects.toThrow('管理员登录状态')
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ error: '密钥备份下载未启用' }),
  } as Response)
  await expect(downloadEncryptionKey()).rejects.toThrow('密钥备份下载未启用')
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})
