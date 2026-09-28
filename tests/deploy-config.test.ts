import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const script = resolve('scripts/configure-deploy.mjs')
const folders: string[] = []
const variables = {
  D1_DATABASE_ID: '11111111-2222-4333-8444-555555555555',
  ACCESS_TEAM_DOMAIN: 'new-team.cloudflareaccess.com',
  ACCESS_AUD: 'new-audience',
  ADMIN_EMAILS: '$&@example.com',
  ENABLE_R2: 'false',
}
function fixture(prefix = '# ') {
  mkdirSync('.local', { recursive: true })
  const folder = mkdtempSync(resolve('.local/deploy-test-'))
  folders.push(folder)
  writeFileSync(
    join(folder, 'wrangler.toml'),
    `name = "statusflare"
[vars]
${prefix}ACCESS_TEAM_DOMAIN = "old-team.cloudflareaccess.com"
${prefix}ACCESS_AUD = "old-audience"
${prefix}ADMIN_EMAILS = "old@example.com"
[[d1_databases]]
binding = "STATUSFLARE_D1"
database_id = "00000000-0000-0000-0000-000000000000"
# [[r2_buckets]]
# binding = "STORAGE"
# bucket_name = "statusflare-storage"
`
  )
  return folder
}
function generate(folder: string, overrides: Record<string, string> = {}) {
  execFileSync(process.execPath, [script], {
    cwd: folder,
    env: { ...process.env, ...variables, ...overrides },
    stdio: 'pipe',
  })
  return readFileSync(join(folder, 'wrangler.deploy.toml'), 'utf8')
}
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
describe('deployment configuration', () => {
  it.each(['# ', ''])(
    'injects current Access settings into a template prefixed with %j',
    (prefix) => {
      const result = generate(fixture(prefix))
      for (const key of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAILS'] as const)
        expect(result).toContain(`${key} = "${variables[key]}"`)
      expect(result).toContain(`database_id = "${variables.D1_DATABASE_ID}"`)
      expect(result).not.toContain('old-audience')
      expect(result).toContain('# [[r2_buckets]]')
    }
  )
  it('enables optional storage without adding other resources', () => {
    const result = generate(fixture(), { ENABLE_R2: 'true' })
    expect(result).toContain('\n[[r2_buckets]]\nbinding = "STORAGE"')
  })
  it('rejects absent and duplicate Access entries instead of silently keeping old values', () => {
    for (const entry of ['', 'ACCESS_AUD = "one"\nACCESS_AUD = "two"']) {
      const folder = fixture()
      const file = join(folder, 'wrangler.toml')
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace('# ACCESS_AUD = "old-audience"', entry)
      )
      expect(() => generate(folder)).toThrow('Expected exactly one ACCESS_AUD entry')
    }
  })
  it('rejects missing required deployment variables', () => {
    expect(() => generate(fixture(), { ACCESS_AUD: '' })).toThrow('Missing ACCESS_AUD')
  })
})
