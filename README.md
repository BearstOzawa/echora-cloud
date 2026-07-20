# Echora Cloud

Echora 官网与版本分发服务。

## 职责

- 托管官网静态资源
- 读取 GitHub Releases
- 提供 Web、桌面端和移动端更新接口
- 使用 KV 缓存发布信息
- 可选使用 R2 提供安装包镜像

版本号、更新说明和安装包地址均来自 GitHub Release，不在官网代码中维护。

## 开发

```bash
npm install
npm run dev
```

本地地址：`http://127.0.0.1:8787/`

## 配置

| 变量 | 必需 | 用途 |
| --- | --- | --- |
| `GITHUB_REPOSITORY` | 是 | Release 仓库，格式为 `owner/repository` |
| `GITHUB_TOKEN` | 否 | 提高 GitHub API 限额或访问私有仓库 |
| `GITHUB_CACHE_SECONDS` | 否 | GitHub Release 缓存时间 |
| `R2_DOWNLOAD_BASE_URL` | 否 | 安装包镜像地址 |
| `WEB_APP_URL` | 否 | Web 版入口 |
| `ALLOWED_ORIGIN` | 否 | API 跨域来源 |

稳定版读取 GitHub 的 latest release。Worker 可根据 `.dmg`、`.exe`、`.msi`、`.AppImage`、`.deb`、`.apk` 和 `.ipa` 自动识别平台。

`echora-release.json` 仅用于最低版本、灰度发布或自定义资产映射，格式见 [examples/echora-release.json](examples/echora-release.json)。

## API

- `GET /health`
- `GET /v1/releases/latest`
- `GET /v1/check`
- `GET /v1/web`
- `GET /v1/mobile/android`
- `GET /v1/mobile/ios`
- `GET /v1/tauri/:channel/:target`

## 验证与部署

```bash
npm run typecheck
npm test
npm run build
npx wrangler deploy
```
