<div align="center">
  <img src="public/brand-mark.svg" width="72" height="72" alt="Echora Cloud" />
  <h1>Echora Cloud</h1>
  <p>Echora 的账户、音乐、AI 与发布基础设施。</p>
  <p>
    <a href="https://echora-cloud.lili.uno">产品网站</a>
    · <a href="https://echora-web.lili.uno">Echora Web</a>
    · <a href="docs/architecture.md">服务架构</a>
    · <a href="docs/deployment.md">部署指南</a>
  </p>
  <p>
    <a href="https://github.com/BearstOzawa/echora-cloud/actions/workflows/ci.yml"><img src="https://github.com/BearstOzawa/echora-cloud/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="https://github.com/BearstOzawa/echora-cloud/actions/workflows/health.yml"><img src="https://github.com/BearstOzawa/echora-cloud/actions/workflows/health.yml/badge.svg" alt="Production health" /></a>
  </p>
</div>

## 关于 Echora Cloud

Echora Cloud 是 [Echora](https://github.com/BearstOzawa/echora) 的云端服务和产品站点，运行在 Cloudflare Workers 上。它为 Web、桌面和移动客户端提供统一的账户、音乐、AI 与版本接口，同时承载官网、用户中心和系统管理。

Cloud 负责短时 API 请求和产品数据，不承载持续音频流量。在线音乐完成检索与解析后，由终端直接连接内容地址；下载、导入音乐和播放缓存始终属于设备本地数据。

## 服务边界

| 领域 | Cloud 负责 | Cloud 不负责 |
| --- | --- | --- |
| 账户 | 身份、会话、设备、恢复与账户生命周期 | 设备本地下载和导入音乐 |
| 用户数据 | 歌单、收藏、设置、AI 会话和长期偏好 | 持续音频流与播放缓存 |
| 在线音乐 | 检索、榜单聚合、播放地址解析和服务健康 | 存储或代理音乐文件 |
| AI | EchoraAI 代理、自定义 AI 配置加密保存 | 在客户端分发官方服务密钥 |
| 产品运营 | 官网、系统管理、版本登记、发布策略和审计 | 代替 GitHub Releases 承载原生安装包 |

## 架构

```text
Echora Web / Desktop / Mobile
              |
              v
        Echora Cloud Worker
        /        |         \
      D1         KV         R2
       |          |          |
  账户与审计   配置与版本   产品资源
              |
              +----> 音乐解析服务 / AI 服务商
```

| Cloudflare 组件 | 用途 |
| --- | --- |
| Workers | API、官网资源、计划任务与上游编排 |
| D1 | 账户、用户数据、管理员、审计、版本和服务健康记录 |
| KV | 系统配置与已发布版本快照 |
| R2 | 官网媒体与对象资源 |
| Turnstile | 注册、恢复、管理员登录和风险提升验证 |

普通账户与管理员使用独立的身份、会话和数据表。版本部署、GitHub Release 导入和正式发布也是相互独立的状态，避免一次构建直接进入用户更新渠道。

更完整的数据边界和发布链路见 [服务架构](docs/architecture.md)。

## 本地开发

需要 Node.js 22 和 Wrangler。

```bash
git clone https://github.com/BearstOzawa/echora-cloud.git
cd echora-cloud
npm ci
npm run dev
```

本地 Worker 默认运行在 `http://127.0.0.1:8787`。浏览器构建变量写入 `.env.local`，Worker 密钥写入 `.dev.vars`；字段清单分别见 `.env.example` 和 `.dev.vars.example`。

```bash
npm run typecheck
npm test
npm run build
npx wrangler d1 migrations apply echora-cloud --local
```

## 部署与发布

D1 结构由 `migrations/` 顺序维护。已部署 migration 不做原地修改，结构变化通过新文件向前演进。

`main` 分支通过 CI 后进入 production 部署工作流：应用 D1 migration、部署 Worker、验证生产源站并登记构建。原生客户端安装包由 GitHub Releases 承载，Release Webhook 导入 Cloud 后由管理员确认发布范围、最低版本与灰度比例。

生产环境、Secrets、首次管理员和 Webhook 配置见 [部署指南](docs/deployment.md)。

## 运维原则

- 生产密钥只存放在 Cloudflare Secrets 和受保护的 GitHub Environment 中。
- 上游音乐平台独立超时与降级，单个平台异常不阻断聚合页面。
- 管理操作写入审计记录，管理员身份不进入普通用户统计。
- 定时任务负责账户清理、风险记录、服务健康保留和 GitHub Release 对账。
- GitHub Actions 每日检查 Cloud、在线音乐入口和 Web 生产源站。

## 参与项目

API、migration 和管理能力的开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请通过 GitHub Security Advisories 私下报告，处理范围见 [SECURITY.md](SECURITY.md)。

## 许可证

项目尚未发布开源许可证。在许可证确定前，仓库内容仅供查看，不授予复制、修改或再分发权利。
