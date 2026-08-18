# 部署

## GitHub 环境

仓库使用 `production` environment 管理生产部署。建议为该环境启用人工审批，并配置：

- Secret `CLOUDFLARE_API_TOKEN`
- Secret `ECHORA_CLOUD_INGESTION_SECRET`
- Variable `CLOUDFLARE_ACCOUNT_ID`

`ECHORA_CLOUD_INGESTION_SECRET` 必须与 Worker 的 `INTERNAL_INGESTION_SECRET` 相同，只用于签名部署登记请求。

## Worker Secrets

生产 Worker 所需字段以 `.dev.vars.example` 为准。逐项设置：

```bash
npx wrangler secret put DATA_ENCRYPTION_KEY
npx wrangler secret put ECHORA_MUSIC_RESOLVER_KEY
npx wrangler secret put ECHORA_AI_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put INTERNAL_INGESTION_SECRET
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

系统管理中的手动同步默认可导入已发布的 GitHub Release。如需在发布前导入草稿，创建仅授权 `BearstOzawa/echora` 的 fine-grained GitHub token，并额外配置：

```bash
npx wrangler secret put GITHUB_TOKEN
```

该凭据仅用于管理员手动导入草稿；定时对账和 Release Webhook 始终只处理已发布版本。
草稿安装包的下载地址由 `PUBLIC_CLOUD_URL` 生成，生产环境应配置为 `https://echora-cloud.lili.uno`。Cloud 以流式响应转发草稿资产，不在响应中暴露 GitHub 凭据。

其余非敏感运行参数可保留在 `wrangler.jsonc` 或管理端配置中。不要将 `.dev.vars`、生产密钥文件或管理员密码提交到仓库。

## 首次部署

1. 创建并绑定 D1、KV 和 R2 资源。
2. 设置 Worker Secrets。
3. 应用全部 D1 migrations。
4. 部署 Worker。
5. 检查 `/health`。
6. 使用引导凭据创建首个管理员。
7. 删除生产环境中的 `ADMIN_BOOTSTRAP_PASSWORD`。

## GitHub Release Webhook

在 Echora 仓库配置 Release Webhook：

- Payload URL：`https://echora-cloud.lili.uno/v1/internal/releases/github`
- Content type：`application/json`
- Secret：与 Worker 的 `GITHUB_WEBHOOK_SECRET` 相同
- Event：Releases

Webhook 仅导入 Release。是否发布、最低版本和灰度比例仍由系统管理确认。

## 回退

Worker 部署失败时不要继续登记健康部署。代码回退使用 Cloudflare 版本回滚；数据库结构按向前兼容方式新增 migration，不通过修改或删除已部署 migration 回退。
