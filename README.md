<p align="center">
  <img src="public/favicon.svg" width="96" height="96" alt="StatusFlare 心跳图标" />
</p>

<h1 align="center">StatusFlare</h1>

<p align="center">
  在 Cloudflare 上监控服务，发布状态，让每一次故障都有清晰的进展。
</p>

<p align="center">
  <a href="https://github.com/Zxis233/StatusFlare/actions/workflows/check.yml"><img src="https://github.com/Zxis233/StatusFlare/actions/workflows/check.yml/badge.svg" alt="Validate StatusFlare 工作流状态" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-55dfb0" alt="License: Apache 2.0" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.13.0-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 22.13.0 或更高版本" /></a>
  <a href="wrangler.toml"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&amp;logoColor=white" alt="Cloudflare Workers" /></a>
  <a href="tsconfig.json"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&amp;logoColor=white" alt="TypeScript 5" /></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/DEPLOY.md">部署指南</a> ·
  <a href="docs/OPERATIONS.md">运行说明</a> ·
  <a href="https://github.com/Zxis233/StatusFlare/issues">反馈问题</a>
</p>

---

## 项目介绍

StatusFlare 将服务监控、公开状态页和管理后台放在一个项目中。前端、API 和定时检测由同一个 Cloudflare Worker 承载，配置、公告及监控历史保存在 D1，可选使用 R2 存储附件和历史归档。

你可以在后台管理监控目标，通过公开状态页展示当前状态与历史趋势，并在故障或维护期间发布公告、更新进展和发送通知。

## 功能特性

| 功能       | 支持内容                                                                |
| ---------- | ----------------------------------------------------------------------- |
| 服务监控   | HTTP / HTTPS / TCP 检测、分组管理、检测间隔、报警宽限期与恢复通知       |
| 公开状态页 | 服务与监控独立访问链接、自定义排序、页面背景、状态徽章与公开 / 私有服务 |
| 历史趋势   | 响应时间图、可用率统计、故障记录与事件时间线                            |
| 公告与维护 | 草稿和公开发布、追加进展、关联受影响服务、维护期间静默自动通知          |
| 通知管理   | Webhook 渠道、失败重试、可编辑正文模板、时区设置与真实发送测试          |
| 后台安全   | Cloudflare Access 管理员认证、敏感检测与通知配置加密                    |
| 数据存储   | 批次状态快照、小时延迟样本、日统计；可选 R2 附件与历史归档              |

技术栈：**React · TypeScript · Vite · Mantine · Cloudflare Workers · D1 · R2（可选）**。

## 快速开始

需要 **Node.js 22.13.0+** 和 Git。以下命令适用于 PowerShell：

```powershell
git clone https://github.com/Zxis233/StatusFlare.git
Set-Location StatusFlare
npm ci

# 首次运行时创建本地环境文件；保留已有配置。
if (-not (Test-Path .dev.vars)) {
  Copy-Item .dev.vars.example .dev.vars
}

npm run db:local
npm run preview
```

启动后访问：

- 公开状态页：<http://localhost:8787/>
- 管理后台：<http://localhost:8787/admin>

本地示例管理员令牌为 `local-development-only`。进入后台后，可添加服务、监控目标和通知渠道。本地开发不会自动模拟每分钟 Cron；需要检测时，手动访问 <http://localhost:8787/__scheduled>。

本地数据在 `.wrangler/`，与云端新数据库分离。示例加密密钥仅供本地测试，云端须生成独立随机密钥。

## 部署到 Cloudflare

按 [部署指南](docs/DEPLOY.md) 完成以下配置：

1. 创建 D1 数据库并应用迁移。
2. 配置生产环境的 `ENCRYPTION_KEY`。
3. 使用 Cloudflare Access 保护后台和管理 API，并设置管理员身份。
4. 配置 GitHub Actions 的 Secrets / Variables，或使用私人配置手动部署。

`wrangler.toml` 是可提交的通用模板，保留占位数据库 ID。真实配置放在已被忽略的 `wrangler.esing.toml` 中，或由配置生成脚本写入 `wrangler.deploy.toml`。默认的 `npm run deploy` 使用通用模板；实际发布时请按部署指南显式选择配置。

监控规模、调度额度、历史保留与通知行为见 [运行说明](docs/OPERATIONS.md)。

## 本地开发

需要热更新时，打开两个终端，分别执行：

```powershell
# 终端 1：本地 Worker / API
npm run dev:worker
```

```powershell
# 终端 2：前端开发服务器
npm run dev
```

访问 Vite 输出的本地地址。修改 `.dev.vars` 后，需要重启 Worker。

<details>
<summary>本地认证与自定义域名</summary>

`preview` 和 `dev:worker` 显式使用本地模式及 `--local-upstream localhost`，避免自定义域名路由改变 Worker 收到的主机名而使本地令牌认证失败。修改启动脚本或 `.dev.vars` 后需重启开发服务；若自行运行 Wrangler，也请保留这些参数。本地认证要求 `.dev.vars` 中的 `ENVIRONMENT=development`、令牌匹配，并通过 localhost 或回环地址访问。

</details>

<details>
<summary>本地通知通过 HTTP 代理发送</summary>

无需虚拟网卡。`preview` 和 `dev:worker` 会读取 `.local/notification-proxy.json`（已被 Git 忽略）：

```json
{ "proxyUrl": "http://127.0.0.1:7890" }
```

也可在 PowerShell 中设置 `$env:STATUSFLARE_NOTIFICATION_PROXY = 'http://127.0.0.1:7890'`，其优先级高于文件。设置为 `off` 可临时关闭；无配置时直连。修改后重启 `npm run preview`。需要有效的 `.dev.vars` 且 `ENVIRONMENT=development`。

启动脚本自动开启仅监听回环地址的通知转发服务，使用每次启动生成的临时认证令牌，通过指定 HTTP/HTTPS 代理发送；退出时关闭。只影响通知渠道测试、模板测试及队列投递，不代理监控探测。线上构建不包含该转发服务的地址或令牌，也无需配置本地代理。请继续在渠道中填写原始公开 HTTPS Webhook 地址，不要改成代理地址。代理不可用时明确报错，不回退直连；本地通知仍会真实发送给接收端。

</details>

### 提交前校验

```powershell
npm test
npm run build
npm run build:worker
```

`build:worker` 仅执行 Worker 打包检查，不会发布。可运行 `node scripts/smoke.mjs` 检查已启动的本地 Worker；该脚本会创建演示记录。

## 项目结构

| 目录                 | 用途                                     |
| -------------------- | ---------------------------------------- |
| `src/`               | React/Vite 状态页与后台                  |
| `server/`            | Worker API、认证、检测、通知、历史       |
| `shared/`            | 类型与应用限制                           |
| `migrations/`        | D1 增量建表脚本，顺序执行全部文件        |
| `scripts/`           | 部署配置生成、本地校验及可选历史导入工具 |
| `tests/`             | SQLite/API/调度与界面测试                |
| `public/`            | 网站图标和静态资源配置                   |
| `docs/`              | 部署指南与运行说明                       |
| `.github/workflows/` | 持续集成与部署                           |

## 反馈与贡献

欢迎通过 [Issues](https://github.com/Zxis233/StatusFlare/issues) 报告问题或提出建议。报告问题时，请提供复现步骤、运行环境和相关错误信息，并移除令牌、密钥及其他私人配置。

提交 Pull Request 前，请运行测试和两项构建检查。数据库结构变更应新增编号迁移文件，保留已经部署的迁移历史。

## 许可证与致谢

StatusFlare 从 [UptimeFlare](https://github.com/lyc8503/UptimeFlare) 的全栈改造版本中抽取并独立维护，感谢 lyc8503 及上游贡献者。

项目采用 [Apache License 2.0](LICENSE)，保留原项目的许可证与来源说明，详见 [NOTICE](NOTICE)。第三方依赖遵循各自的许可证。本项目是独立维护的衍生项目，不是上游官方发行版。
