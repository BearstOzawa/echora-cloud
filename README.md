# Echora Cloud

Echora 官网与跨端版本服务。Cloudflare Worker 提供官网、下载中心和版本检测；GitHub Releases 是发布事实源，KV 只保存短期缓存与最后一次可用快照。桌面安装包、APK 与 IPA 由 GitHub Releases 发布，并可同步到 R2 作为国内下载入口。

## 本地开发

```bash
npm install
npm test
npm run dev
```

本地地址：

```text
http://127.0.0.1:8787/
```

官网路由：

- `/` 产品首页
- `/download` 动态下载中心
- `/releases` 版本记录
- `/privacy` 隐私说明

官网不保存版本号或安装包地址，页面通过 `/v1/releases/latest` 获取当前 GitHub Release，并提供对应的 Release 页面和备用下载入口。

复制本地变量并填写 GitHub 仓库：

```bash
cp .dev.vars.example .dev.vars
```

`GITHUB_REPOSITORY` 指向发布 Echora 安装包的仓库，使用 `owner/repository` 格式。公开仓库无需 Token；需要提高 GitHub API 限额时，通过 `npx wrangler secret put GITHUB_TOKEN` 配置，禁止提交到仓库。

创建 KV 并把生成的绑定加入 `wrangler.jsonc`：

```bash
npx wrangler kv namespace create RELEASES
```

```jsonc
"kv_namespaces": [
  { "binding": "RELEASES", "id": "Cloudflare 返回的 namespace id" }
]
```

KV 不需要手动写版本。Worker 首次读取 GitHub 后会写入缓存，GitHub 暂时不可用时继续返回最后一次成功结果。

## GitHub Release 约定

稳定版使用 GitHub 的 latest release，版本标签必须是 SemVer，例如 `v0.2.0`。Worker 可以根据常见安装包名称自动识别 macOS、Windows、Linux、Android 和 iOS。

需要最低版本、灰度或精确资产映射时，在 Release 中附加由 CI 生成的 `echora-release.json`：

```bash
cat examples/echora-release.json
```

版本号、发布时间和默认更新说明始终读取 GitHub Release，不在 Worker 中写死。Tauri 签名私钥、Android keystore 和 Apple 证书只能存放在 CI Secrets。

## 国内下载

只把版本检测放到 Cloudflare 不能解决 GitHub 安装包下载失败。配置 `R2_DOWNLOAD_BASE_URL` 后，Worker 会按以下规则优先返回 R2 地址，并保留 GitHub 原地址作为备用：

```text
{R2_DOWNLOAD_BASE_URL}/{release-tag}/{asset-name}
```

发布流水线应把 GitHub Release 的同名附件同步到该 R2 路径。Worker 不代理大文件，避免请求时长、流量和稳定性问题。

## 接口

- `GET /health`
- `GET /v1/releases/latest`
- `GET /v1/check`
- `GET /v1/web`
- `GET /v1/mobile/android`
- `GET /v1/mobile/ios`
- `GET /v1/tauri/:channel/:target`

官网使用 `/v1/releases/latest` 一次读取当前版本、更新说明和全部公开下载项；客户端使用 `/v1/check` 获得与当前设备匹配的单一动作。

通用检查参数：

```text
current=0.1.0
platform=desktop|mobile|web
os=darwin|windows|linux|android|ios|browser
arch=aarch64|x86_64|universal
channel=stable
installationId=随机本地安装标识
buildId=Web 构建标识
```

`installationId` 由应用随机生成，用于稳定灰度分桶，不读取硬件标识。更新服务不可用时，Echora 应继续正常启动和播放。

## 发布

```bash
npm run typecheck
npm test
npm run deploy
```

Cloudflare Static Assets 与 Worker 使用同一次部署。`/health` 和 `/v1/*` 由 Worker 处理，其余路径由官网静态资源处理。
