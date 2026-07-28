# 贡献指南

## 开始之前

- API 行为变化必须同步更新测试和终端契约。
- D1 结构变化只能新增 migration，不修改已部署文件。
- 不要提交 `.dev.vars`、生产变量、账户数据或 Cloudflare 访问令牌。
- 管理接口必须使用管理员会话并写入审计记录。

## 本地验证

```bash
npm ci
npm run typecheck
npm test
npm run build
npx wrangler d1 migrations apply echora-cloud --local
```

## 提交要求

- 一个提交只处理一个明确主题。
- 新增接口应覆盖成功、鉴权失败、输入错误和依赖不可用场景。
- 上游服务调用必须设置超时，并返回稳定的产品错误码。
- 新增密钥时只更新 `.dev.vars.example` 中的字段说明。

Pull Request 应说明 API 或数据结构变化、迁移顺序、验证命令和回退边界。
