# Echora Cloud

Echora Cloud 是 Echora 的云端服务与产品站点，运行在 Cloudflare Workers 上。

- 官网与账户：[echora-cloud.lili.uno](https://echora-cloud.lili.uno)
- Web 应用：[echora-web.lili.uno](https://echora-web.lili.uno)
- 客户端仓库：[BearstOzawa/echora](https://github.com/BearstOzawa/echora)

## 服务职责

- 账户、会话和设备管理
- 歌单、收藏、设置、AI 会话与长期偏好
- 在线音乐检索、榜单聚合和播放地址解析
- EchoraAI 请求代理与自定义 AI 配置保管
- 官网、用户中心和系统管理
- Web、桌面、Android 与 iOS 的版本登记和发布策略

音乐解析请求由 Cloud 发起，音频地址返回后由终端直连内容源。下载音乐、导入音乐和播放缓存保存在设备本地，不进入账户数据，也不经过 Cloud 持续转发。

## 技术结构

| 组件 | 职责 |
| --- | --- |
| Workers | HTTP API、官网资源、计划任务 |
| D1 | 账户、云端数据、管理员、审计、版本与服务健康记录 |
| KV | 系统配置和已发布版本快照 |
| R2 | 官网媒体与对象资源 |
| Turnstile | 风险场景下的人机验证 |

普通账户与管理员使用独立的身份、会话和数据表。管理员不计入用户与设备统计。

完整边界见 [docs/architecture.md](docs/architecture.md)。

## 开发

需要 Node.js 22 和 Wrangler。

```bash
npm ci
npm run dev
```

本地 Worker 默认运行在 `http://127.0.0.1:8787`。公开配置写入 `.env.local`，服务端密钥写入 `.dev.vars`；可用字段见 `.env.example` 和 `.dev.vars.example`。

提交前运行：

```bash
npm run typecheck
npm test
npm run build
```

## 数据库

D1 结构通过 `migrations/` 顺序维护。不要修改已经部署的 migration；结构变化应新增文件。

```bash
npx wrangler d1 migrations apply echora-cloud --local
npx wrangler d1 migrations apply echora-cloud --remote
```

生产迁移和 Worker 部署由 GitHub Actions 的 production environment 管理。手工部署流程见 [docs/deployment.md](docs/deployment.md)。

## 版本管理

Web 与 Cloud 部署完成后通过签名接口登记构建。Echora 原生安装包由 GitHub Releases 承载，Release 发布事件通过 Webhook 导入 Cloud，管理员确认后才进入正式更新渠道。

Cloud 不在请求时实时读取 GitHub，也不在代码中重复维护安装包地址。

## 贡献与安全

提交代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题和凭据泄露请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

项目尚未发布开源许可证。在许可证确定前，仓库内容仅供查看，不授予复制、修改或再分发权利。
