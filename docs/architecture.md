# 服务架构

## 请求边界

```text
Echora Web / Desktop / Mobile
  -> Echora Cloud
      -> D1 / KV / R2
      -> music resolver
      -> EchoraAI provider

terminal -> resolved audio URL
```

Cloud 负责鉴权、配置、聚合和解析，不代理持续音频流量。终端获得可播放地址后直接连接内容源。

## 身份体系

普通账户和管理员账户完全分离：

- 普通账户使用用户会话，访问个人数据和 EchoraAI。
- 管理员使用独立会话，访问系统配置、用户管理、版本与审计。
- 管理员引导凭据只用于创建首个管理员，完成后应从生产 Secrets 删除。
- Turnstile 用于注册、恢复、管理员登录和被风控提升的普通登录。

## 数据所有权

| 数据 | 存储 | 说明 |
| --- | --- | --- |
| 账户、歌单、收藏、设置、会话 | D1 | 云端主数据 |
| 自定义 AI 凭据 | D1 | 使用服务端数据密钥加密 |
| 系统能力配置 | KV | 管理端维护 |
| 已发布版本快照 | KV | 更新检查快速读取 |
| 版本、部署和审计记录 | D1 | 可追溯记录 |
| 官网媒体和对象资源 | R2 / Worker Assets | 不保存用户下载音乐 |
| 本地音乐、下载和播放缓存 | 用户设备 | 不属于账户数据 |

## 版本链路

```text
Web/Cloud deployment
  -> signed deployment endpoint
  -> D1 deployment record

GitHub Release published
  -> signed GitHub webhook
  -> draft release import
  -> administrator review
  -> published KV snapshot
  -> client update check
```

部署记录与产品发布是两类状态。部署成功不代表客户端版本已向用户发布。

## 运行约束

- 所有用户输入在写入前进行长度和类型校验。
- 密码派生迭代次数不得超过 Cloudflare Workers WebCrypto 的平台限制。
- 管理操作写入审计记录。
- 上游音乐平台分别超时和降级，单个平台失败不应拖垮聚合请求。
- 服务密钥只能通过 Wrangler 或 GitHub Secrets 注入。
