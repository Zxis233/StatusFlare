import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { api } from '../server/api'
import { seal, unseal } from '../server/core'
import { database } from './database'

let fixture: ReturnType<typeof database>
let adminToken: string
let otherToken: string
let publicJwk: Awaited<ReturnType<typeof exportJWK>>
const origin = 'https://status.example.com'
beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true })
  publicJwk = { ...(await exportJWK(keys.publicKey)), kid: 'backup-test', alg: 'RS256', use: 'sig' }
  const sign = (email: string) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'backup-test' })
      .setIssuer('https://backup-test.cloudflareaccess.com')
      .setAudience('backup-test-aud')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey)
  adminToken = await sign('admin@example.com')
  otherToken = await sign('other@example.com')
})
beforeEach(() => {
  fixture = database()
  Object.assign(fixture.env, {
    ENVIRONMENT: 'production',
    ACCESS_TEAM_DOMAIN: 'backup-test.cloudflareaccess.com',
    ACCESS_AUD: 'backup-test-aud',
    ADMIN_EMAILS: 'admin@example.com',
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => Response.json({ keys: [publicJwk] }))
  )
})
afterEach(() => {
  fixture.sqlite.close()
  vi.unstubAllGlobals()
})
function download(
  options: { method?: string; token?: string | null; headers?: Record<string, string | null> } = {}
) {
  const headers = new Headers({ origin, 'x-statusflare-key-export': '1' })
  if (options.token !== null) headers.set('cf-access-jwt-assertion', options.token || adminToken)
  for (const [key, value] of Object.entries(options.headers || {})) {
    if (value === null) headers.delete(key)
    else headers.set(key, value)
  }
  return api(
    new Request(`${origin}/api/admin/encryption-key/export`, {
      method: options.method || 'POST',
      headers,
    }),
    fixture.env
  )
}
describe('administrator encryption key backup', () => {
  it('is disabled until explicitly enabled and stops again when disabled', async () => {
    await expect(download()).rejects.toMatchObject({ status: 404 })
    fixture.env.ENABLE_KEY_EXPORT = 'true'
    expect((await download()).status).toBe(200)
    delete fixture.env.ENABLE_KEY_EXPORT
    await expect(download()).rejects.toMatchObject({ status: 404 })
  })
  it('downloads the working key with no caching and only a non-secret audit record', async () => {
    fixture.env.ENABLE_KEY_EXPORT = 'true'
    const encrypted = await seal(fixture.env, { target: 'https://example.com/private' })
    const original = fixture.env.ENCRYPTION_KEY!
    const response = await download()
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toContain('attachment; filename=')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe(`ENCRYPTION_KEY=${original}\n`)
    expect(fixture.env.ENCRYPTION_KEY).toBe(original)
    expect(await unseal(fixture.env, encrypted)).toEqual({ target: 'https://example.com/private' })
    const rows = fixture.sqlite.prepare('SELECT * FROM audit_logs').all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor: 'admin@example.com',
      action: 'encryption-key.export',
      resource: 'ENCRYPTION_KEY',
    })
    expect(JSON.stringify(rows)).not.toContain(original)
    const overview = (await (
      await api(
        new Request(`${origin}/api/admin/overview`, {
          headers: { 'cf-access-jwt-assertion': adminToken },
        }),
        fixture.env
      )
    ).json()) as any
    expect(overview.keyExportEnabled).toBe(true)
    expect(JSON.stringify(overview)).not.toContain(original)
  })
  it('rejects anonymous, forged-identity, disallowed-user and API-token requests', async () => {
    fixture.env.ENABLE_KEY_EXPORT = 'true'
    await expect(download({ token: null })).rejects.toMatchObject({ status: 401 })
    await expect(
      download({
        token: null,
        headers: { 'cf-access-authenticated-user-email': 'admin@example.com' },
      })
    ).rejects.toMatchObject({ status: 401 })
    await expect(download({ token: otherToken })).rejects.toMatchObject({ status: 403 })
    fixture.env.ADMIN_API_TOKEN = 'test-admin-token'
    await expect(
      download({ token: null, headers: { authorization: 'Bearer test-admin-token' } })
    ).rejects.toMatchObject({ status: 403 })
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()!.n).toBe(0)
  })
  it('rejects GET, cross-origin and non-explicit export requests', async () => {
    fixture.env.ENABLE_KEY_EXPORT = 'true'
    await expect(download({ method: 'GET' })).rejects.toMatchObject({ status: 405 })
    const rejectedHeaders: Record<string, string | null>[] = [
      { origin: 'https://evil.example.com' },
      { origin: null },
      { 'x-statusflare-key-export': null },
    ]
    for (const headers of rejectedHeaders)
      await expect(download({ headers })).rejects.toMatchObject({ status: 403 })
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()!.n).toBe(0)
  })
  it('fails without exporting missing or malformed keys', async () => {
    fixture.env.ENABLE_KEY_EXPORT = 'true'
    for (const key of [undefined, 'invalid-key', btoa('too-short')]) {
      fixture.env.ENCRYPTION_KEY = key
      await expect(download()).rejects.toMatchObject({ status: 503 })
    }
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()!.n).toBe(0)
  })
})
