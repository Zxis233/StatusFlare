// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import type { Env } from '../server/env'
export function database() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  for (const file of readdirSync(new URL('../migrations/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
  function written(sql: string, before: number) {
    const changes = Number(sqlite.prepare('SELECT total_changes() AS n').get()!.n) - before
    const table = /^(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(\w+)/i.exec(sql.trim())?.[1]
    // Conservative billing model: assume every index is rewritten, even on non-indexed updates.
    const indexes = table ? sqlite.prepare(`PRAGMA index_list(${table})`).all().length : 0
    return changes * (1 + indexes)
  }
  class Statement {
    constructor(
      readonly sql: string,
      readonly params: any[] = []
    ) {}
    bind(...params: any[]) {
      return new Statement(this.sql, params)
    }
    async first(column?: string) {
      const row = sqlite.prepare(this.sql).get(...this.params)
      return row ? (column ? row[column] : row) : null
    }
    async all() {
      const before = Number(sqlite.prepare('SELECT total_changes() AS n').get()!.n)
      const rows = sqlite.prepare(this.sql).all(...this.params)
      return {
        results: rows,
        success: true,
        meta: {
          changes: Number(sqlite.prepare('SELECT changes() AS n').get()!.n),
          rows_written: written(this.sql, before),
        },
      }
    }
    async run() {
      const before = Number(sqlite.prepare('SELECT total_changes() AS n').get()!.n)
      const result = sqlite.prepare(this.sql).run(...this.params)
      return {
        results: [],
        success: true,
        meta: { changes: Number(result.changes), rows_written: written(this.sql, before) },
      }
    }
  }
  const value = {
    prepare: (sql: string) => new Statement(sql),
    withSession() {
      return this
    },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const s of statements) results.push(await s.run())
        sqlite.exec('COMMIT')
        return results
      } catch (e) {
        sqlite.exec('ROLLBACK')
        throw e
      }
    },
  }
  const env = {
    STATUSFLARE_D1: value,
    ENVIRONMENT: 'development',
    DEV_ADMIN_TOKEN: 'test-token',
    ENCRYPTION_KEY: btoa('a'.repeat(32)),
  } as unknown as Env
  return { env, sqlite }
}
