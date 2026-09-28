// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
async function authenticatedFetch(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers)
  if (options.body && typeof options.body === 'string')
    headers.set('content-type', 'application/json')
  const token = sessionStorage.getItem('statusflare-local-token')
  if (token) headers.set('authorization', `Bearer ${token}`)
  return fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  })
}
export async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await authenticatedFetch(path, options)
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('登录已过期，请刷新页面通过 Cloudflare Access 登录')
  const result: any = await response.json()
  if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`)
  return result as T
}
export async function downloadEncryptionKey(): Promise<void> {
  const response = await authenticatedFetch('/api/admin/encryption-key/export', {
    method: 'POST',
    headers: { 'x-statusflare-key-export': '1' },
  })
  if (!response.ok || !response.headers.get('content-type')?.includes('application/octet-stream')) {
    if (response.headers.get('content-type')?.includes('application/json')) {
      const result = (await response.json()) as { error?: unknown }
      throw new Error(typeof result.error === 'string' ? result.error : '密钥备份下载失败')
    }
    throw new Error('下载失败，请刷新页面确认管理员登录状态')
  }
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = 'statusflare-encryption-key.env'
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    // Allow the browser to begin saving before releasing the temporary object URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
export const formatTime = (time: number | null | undefined) =>
  time ? new Date(time * 1000).toLocaleString() : '—'
export const localDate = (time: number) => {
  const d = new Date(time * 1000)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
export const epoch = (value: string) => Math.floor(new Date(value).getTime() / 1000)
