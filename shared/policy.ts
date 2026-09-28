// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
// Application limits shared by scheduling, management and public APIs.
export const POLICY = {
  defaultInterval: 600,
  minimumInterval: 60,
  checksPerMinute: 20,
  checksPerDay: 48000,
  maxMonitors: 50,
  maxChannels: 5, // Maximum simultaneously enabled notification channels.
  eventComponents: 20,
  eventAttachments: 5,
  importRows: 20,
  publicPageSize: 20,
  publicRefreshSeconds: 30,
  writeBudget: 80000,
} as const
