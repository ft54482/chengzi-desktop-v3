# DSH 橙子Pro 账号插件

[English readme](README.md)

橙子Pro 账号是 DSH Desktop 橙子Pro 版本内置的账号插件。它使用中国大陆手机号和短信验证码登录，会话保存在 Host 侧，并在设置的「账号」分区中展示账号状态。

## 行为

- 设置分区「账号」（`chengzi-account`）提供手机号 + 短信验证码登录，展示手机号、token 余额和账号开通状态，并提供「刷新」「退出登录」按钮。
- Renderer 永远接触不到 BFF 令牌。它只调用 Host 本地 web server 暴露的回环路由；由 Host 附加 Bearer 头、在令牌过期时自动轮换一次，并在刷新失败时清除已保存的会话。
- 短信验证码请求在本地按手机号限频（每分钟一次），叠加服务端的任何限制。

## Host 路由

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/plugins/chengzi-account/sms-code` | 转发验证码请求（本地限频）。 |
| POST | `/plugins/chengzi-account/login` | 用手机号 + 验证码换取会话，由 Host 保存。 |
| POST | `/plugins/chengzi-account/logout` | 尽力吊销刷新令牌并清除会话。 |
| GET | `/plugins/chengzi-account/me` | 登录态、手机号和余额；401 时自动刷新一次。 |
| GET | `/plugins/chengzi-account/api-key` | 已开通的 API key 视图；409 时携带 `provisionState`。 |

每条路由在读取任何内容前都先执行 Connection 来源校验，请求体有大小上限，且只返回 JSON。

## 配置

BFF 源默认为 `https://api.chengzipro.cn`，可用环境变量 `CHENGZI_BFF_BASE_URL` 覆盖（例如本地联调时使用 `http://127.0.0.1:8080`；仅回环地址允许明文 HTTP）。

## 安全

- 会话令牌只保存在凭据体系中：一条位于 `chengzi-account/session` 的 `GrantRecord`，且只通过凭据体系的串行化读-改-写写入，并发轮换令牌不会丢失写入。
- 令牌不会到达 Renderer，不会出现在日志中，也不会被错误信息回显。
- BFF 响应按 64 KiB 上限读取；非 JSON 或畸形响应体安全失败，不回显响应内容。
