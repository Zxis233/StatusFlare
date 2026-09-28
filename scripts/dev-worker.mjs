import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startNotificationRelay } from './notification-relay.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
// This launcher must never pass its ephemeral relay capability to remote dev/deploy.
if (args.some((arg) => /^(?:--remote(?:=.*)?|-r|--no-local)$/.test(arg))) {
  throw new Error('此启动脚本仅支持本地开发')
}
let proxyUrl = process.env.STATUSFLARE_NOTIFICATION_PROXY
if (proxyUrl === undefined) {
  try {
    proxyUrl = JSON.parse(
      await readFile(resolve(root, '.local/notification-proxy.json'), 'utf8')
    ).proxyUrl
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('请检查 .local/notification-proxy.json 配置格式')
  }
}
let relay
if (proxyUrl && proxyUrl !== 'off') {
  relay = await startNotificationRelay(proxyUrl)
  const proxy = new URL(proxyUrl)
  console.log(`本地通知代理已启用：${proxy.protocol}//${proxy.host}（仅通知发送）`)
} else console.log('本地通知代理未启用，通知将直连发送')

const wrangler = resolve(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js')
const child = spawn(
  process.execPath,
  [
    wrangler,
    'dev',
    ...args,
    '--local',
    '--test-scheduled',
    '--local-upstream',
    'localhost',
    ...(relay
      ? [
          '--define',
          `__STATUSFLARE_LOCAL_NOTIFICATION_RELAY__:${JSON.stringify({
            url: relay.url,
            token: relay.token,
          })}`,
        ]
      : []),
  ],
  { cwd: root, stdio: 'inherit', windowsHide: true }
)

let stopping = false
async function stop(code) {
  if (stopping) return
  stopping = true
  if (child.exitCode === null && child.pid) {
    if (process.platform === 'win32') {
      // Terminate this launcher's child tree, including the local workerd runtime.
      await new Promise((done) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        killer.once('error', done)
        killer.once('exit', done)
      })
    } else child.kill('SIGTERM')
  }
  await relay?.close()
  process.exitCode = code
}
process.once('SIGINT', () => void stop(130))
process.once('SIGTERM', () => void stop(143))
child.once('error', () => {
  console.error('本地 Worker 启动失败')
  void stop(1)
})
child.once('exit', (code) => void stop(code ?? 1))
