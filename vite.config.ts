// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8787', '/attachments': 'http://127.0.0.1:8787' } },
  test: { include: ['tests/**/*.test.{ts,tsx}'], fileParallelism: false },
})
