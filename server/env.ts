// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import type { RemoteChecker } from './index'
export interface Env {
  STATUSFLARE_D1: D1Database
  ASSETS: Fetcher
  STORAGE?: R2Bucket
  REMOTE_CHECKER_DO?: DurableObjectNamespace<RemoteChecker>
  ENCRYPTION_KEY?: string
  ENABLE_KEY_EXPORT?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  ADMIN_EMAILS?: string
  ADMIN_API_TOKEN?: string
  DEV_ADMIN_TOKEN?: string
  ENVIRONMENT?: string
}
