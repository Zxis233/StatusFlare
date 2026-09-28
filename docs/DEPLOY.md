# 部署 StatusFlare

StatusFlare 使用一个 Cloudflare Worker 承载网页、API 和每分钟定时检测，D1 保存配置与历史数据。R2 为可选资源，用于附件和历史归档。

## 准备

- Cloudflare 账号、用于后台登录的邮箱。
- Node.js 22.13+、npm、Git。
- 使用自动部署时，需要一个 GitHub 仓库。

在项目根目录执行：

```powershell
npm ci
npx wrangler login
npx wrangler whoami
```

若账号存在多个 Account，可通过 `$env:CLOUDFLARE_ACCOUNT_ID = '你的账号ID'` 指定目标。

## 创建数据库

```powershell
npx wrangler d1 create statusflare_db
```

`wrangler.toml` 是可提交的通用模板，数据库 ID 保留为全零占位值，Access 参数为注释模板。GitHub Actions 使用下文的 Variables 生成已被 Git 忽略的 `wrangler.deploy.toml`。

手动部署时，将模板复制为已被 Git 忽略的 `wrangler.esing.toml`；若该文件已存在，保留现有配置，不要覆盖。将新数据库 ID 填入 `wrangler.esing.toml` 的现有 D1 小节，不要重复追加：

```toml
[[d1_databases]]
binding = "STATUSFLARE_D1"
database_name = "statusflare_db"
database_id = "你的数据库UUID"
migrations_dir = "migrations"
```

`STATUSFLARE_D1` 是固定 binding。根据自己的资源名称设置 Worker 的 `name` 和 D1 的 `database_name`；保留每分钟 Cron、SQLite Durable Object binding 及 `v1` migration。已有实例应继续使用原数据库并执行增量迁移。

## 首次发布

依次运行：

```powershell
npm test
npm run build
npx wrangler d1 migrations apply STATUSFLARE_D1 --remote --config wrangler.esing.toml
npx wrangler deploy --config wrangler.esing.toml
```

迁移会顺序执行 `migrations/` 中的全部文件，包括监控公开链接的 `0009_monitor_link.sql`。执行前核对账号和目标数据库。不要修改或重命名已应用的迁移。

发布后，Wrangler 输出 Worker 地址，例如 `https://statusflare.你的子域.workers.dev`。访问 `/api/health` 应返回 `{"ok":true}`，首页应能打开。后台认证还需完成以下配置。

## 配置加密密钥

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put ENCRYPTION_KEY --config wrangler.esing.toml
```

将生成的密钥输入 secret 提示。保管好密钥：监控请求头和通知凭据依赖它解密，投入使用后不能随意替换。不要将密钥写入仓库、GitHub Variables 或 `wrangler.toml`；示例文件中的密钥仅供本地测试。

## 配置后台认证

在 Cloudflare Zero Trust 设置团队域名，例如 `my-team.cloudflareaccess.com`。创建一个 Self-hosted Access 应用，在同一个应用中保护：

| Hostname         | Path           |
| ---------------- | -------------- |
| 你的 Worker 域名 | `/admin`       |
| 同上             | `/admin/*`     |
| 同上             | `/api/admin/*` |

使用 Emails Allow 策略限定管理员邮箱，并配置登录方式，例如邮件 One-time PIN。记录团队域名和 Application Audience（AUD）。公开首页不应纳入登录保护。

程序还会验证 Access JWT 和管理员邮箱，下一节的三个 Access 变量必须与应用配置一致。手动部署时，在 `wrangler.esing.toml` 的 `[vars]` 中填写 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`ADMIN_EMAILS`。参考 [Access 与 Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)。

## 配置 GitHub Actions

在 Cloudflare 创建具有 Workers 发布及 D1 Edit 权限的 API Token，限定到目标账号。在 GitHub 仓库的 Settings → Secrets and variables → Actions 中填写：

| 类型     | 名称                    | 内容                                    |
| -------- | ----------------------- | --------------------------------------- |
| Secret   | `CLOUDFLARE_API_TOKEN`  | 发布 Token                              |
| Secret   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID                   |
| Variable | `D1_DATABASE_ID`        | D1 数据库 UUID                          |
| Variable | `ACCESS_TEAM_DOMAIN`    | 团队域名，不含协议和路径                |
| Variable | `ACCESS_AUD`            | Access 应用 AUD                         |
| Variable | `ADMIN_EMAILS`          | 管理员邮箱，多个以英文逗号分隔          |
| Variable | `ENABLE_R2`             | 默认 `false`；绑定附件存储时设置 `true` |

`ENCRYPTION_KEY` 保存在 Worker Secret 中，不需要重复放入 GitHub。参考 [Cloudflare GitHub Actions 文档](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)。

`scripts/configure-deploy.mjs` 从 Variables 注入数据库和 Access 配置，生成 `wrangler.deploy.toml`。Access 参数在根配置中可以是注释模板或已有配置，CI 均会替换为 Variables 中的值：

```toml
# ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com"
# ACCESS_AUD = "your-access-application-audience"
# ADMIN_EMAILS = "you@example.com"
```

不要提交生成配置、密钥或本地数据库。配置变量缺失时，部署工作流会停止。

推送到 `main` 后，**Deploy StatusFlare** 会依次测试、构建、生成配置、验证 Worker 包、执行数据库迁移并发布。PR 和其他分支执行检查。更换发布分支时，同步修改 `.github/workflows/deploy.yml`；也可在 Actions 中手动运行部署工作流。

日常发布使用这一流程。如需手动发布，先在终端设置相同变量，再执行：

```powershell
npm run configure:deploy
npm run build
npx wrangler d1 migrations apply STATUSFLARE_D1 --remote --config wrangler.deploy.toml
npx wrangler deploy --config wrangler.deploy.toml
```

直接运行 `npm run deploy` 使用通用的 `wrangler.toml`，不会读取 GitHub Variables，也不会自动选择 `wrangler.esing.toml`。通用模板不能直接用于生产部署；使用生成的 `wrangler.deploy.toml` 或显式传入私人配置。`wrangler.esing.toml` 不应提交到 Git。

## 检查站点

访问 `/admin` 并通过 Access 登录，依次添加分组、服务、监控及通知渠道。服务和监控均可配置独立的公开访问链接。

使用无痕窗口确认：公开首页无需登录，后台要求登录，私有服务不显示。等待 Cron 后查看最新检测时间，使用渠道的“发送测试通知”检查通知配置。调度间隔、运行限制和数据保留见 [运行说明](OPERATIONS.md)。

## 可选配置

需要自定义域名时，在私人配置中添加；通过 GitHub Actions 部署时，在通用模板中配置你准备公开的域名：

```toml
[[routes]]
pattern = "status.example.com"
custom_domain = true
```

将域名替换为自己的域名，为发布 Token 增加相应 Zone 的 Workers Routes 编辑权限，并在同一个 Access 应用中增加新域名的后台路径。如果仍开放 workers.dev，也需保留其后台保护。参考 [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

需要附件和历史归档时，创建 `statusflare-storage` R2 bucket，并设置 `ENABLE_R2=true`。若使用其他 bucket 名称，同步修改根配置中的 R2 模板。R2 用量单独计量。

## 常见问题

| 现象                     | 检查内容                                              |
| ------------------------ | ----------------------------------------------------- |
| D1 找不到数据库          | 账号、数据库 UUID、`STATUSFLARE_D1` binding           |
| 配置生成失败             | 数据库与 Access Variables 是否完整                    |
| 后台未配置认证或返回 403 | 发布配置、团队域名、AUD、Access 策略与 `ADMIN_EMAILS` |
| 首页也要求登录           | 是否误保护整个域名                                    |
| 保存监控提示密钥无效     | Worker Secret 是否为 32 字节 Base64 密钥              |
| 监控未立即更新           | Cron、启用状态、检测间隔、待检测目标数及运行用量      |
| 推送后没有部署           | 发布分支与 GitHub Actions 是否启用                    |
