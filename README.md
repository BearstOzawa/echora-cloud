# Echora Cloud

Echora 的官网、账户数据、在线音乐、托管 AI 与版本分发服务。

## 产品边界

- 在线音乐无需登录；Cloud 负责检索与解析，音频由终端直连内容源。
- Echora AI 需要登录并经 Cloud 转发；自定义 AI 由终端直连，凭据加密保存。
- 设置、歌单、收藏、会话和长期偏好以云端为准，原生端保留离线快照与待提交更改。
- 下载和导入音乐属于设备，不进入账户数据，也不经过 Cloud 存储或转发。
- 版本与安装包来自 GitHub Releases；R2 只承载官网媒体、头像、附件或可选安装包镜像。

## Cloudflare 资源

| 资源 | 名称 | 职责 |
| --- | --- | --- |
| Worker | `echora-cloud` | API、官网与定时任务 |
| D1 | `echora-cloud` | 账户、云端数据、版本记录和审计 |
| KV | `echora-cloud` | 系统配置与已发布版本快照 |
| R2 | `echora-cloud` | 产品文件与对象资源 |

## 账户与管理

- 普通账户与管理员账户使用独立的数据表、会话和入口；管理员不参与用户数据、设备与同步统计。
- 注册、账户恢复和管理员登录使用 Turnstile；普通登录仅在连续失败或触发限流后要求验证。
- 管理操作写入审计记录。管理员无恢复码，密码由已登录的管理员自行更新。

## 开发

```bash
npm install
npm run dev
```

本地地址为 `http://127.0.0.1:8787/`。本地密钥写入 `.dev.vars`，字段见 `.dev.vars.example`。

## 部署

生产密钥写入已忽略的 `.prod.vars`，或逐项使用 `wrangler secret put`。不要提交密钥，也不需要通过聊天传递。

`ADMIN_BOOTSTRAP_USERNAME` 与 `ADMIN_BOOTSTRAP_PASSWORD` 只用于首次建立管理员账户。首次登录 `/admin` 后，密码由独立管理员账户维护，可删除生产环境中的 `ADMIN_BOOTSTRAP_PASSWORD`。

```bash
npm run typecheck
npm test
npm run build
npx wrangler secret bulk .prod.vars
npx wrangler d1 migrations apply echora-cloud --remote
npx wrangler deploy
```

## 版本与发布

D1 保存产品、版本、部署与发布策略；KV 提供已发布快照。GitHub Releases 负责安装包，导入后由管理员确认发布。客户端更新检查不实时访问 GitHub。

GitHub Webhook 使用 `/v1/internal/releases/github`，部署登记使用 `/v1/internal/deployments`。对应密钥为 `GITHUB_WEBHOOK_SECRET` 与 `INTERNAL_INGESTION_SECRET`。
