// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { readFile, writeFile } from 'node:fs/promises'
const id = process.env.D1_DATABASE_ID
if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
  throw new Error('D1_DATABASE_ID must be the UUID of your new StatusFlare D1 database')
if (id === '00000000-0000-0000-0000-000000000000')
  throw new Error('Replace the placeholder D1_DATABASE_ID before deployment')
for (const key of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAILS'])
  if (!process.env[key]?.trim())
    throw new Error(`Missing ${key}: configure GitHub Actions Variables`)
let config = (await readFile('wrangler.toml', 'utf8')).replace(/\r\n/g, '\n')
if (!/^database_id\s*=\s*"[^"]*"/m.test(config))
  throw new Error('Missing D1 database_id in wrangler.toml')
config = config.replace(/^database_id\s*=\s*"[^"]*"/m, `database_id = "${id}"`)
for (const key of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAILS']) {
  const value = process.env[key].trim()
  const entry = new RegExp(`^[ \\t]*(?:#[ \\t]*)?${key}[ \\t]*=.*$`, 'gm')
  if ([...config.matchAll(entry)].length !== 1)
    throw new Error(`Expected exactly one ${key} entry in wrangler.toml`)
  config = config.replace(entry, () => `${key} = ${JSON.stringify(value)}`)
}
if (process.env.ENABLE_R2 === 'true')
  config = config.replace(/^# (\[\[r2_buckets\]\]|binding = "STORAGE"|bucket_name = .*)$/gm, '$1')
await writeFile('wrangler.deploy.toml', config)
console.log('Generated wrangler.deploy.toml (no credentials included).')
