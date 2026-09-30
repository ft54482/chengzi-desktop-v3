# dsh-plugin-chengzi-image

橙子PRO `generate_image` agent 工具插件（纯 host 侧，无客户端界面）。v3：迁入
deepseek-harness 0.2.0-rc.2 官方基底。

- 用户在对话中用自然语言请求生图时，agent 调用 `generate_image` 工具
- 工具自带确认卡：意图确认 + 按次费用提醒 + 未指明分辨率时询问（标准 ¥0.20/张、4K ¥0.60/张）；取消不扣费
- 费用确认走 user-questions 审批式 intent（approve 选项 + detail 成本明细），能力 UI 渲染为批准/拒绝卡
- 平台 `POST /v1/images/generations`，key 按次经 `ctx.credentials.resolve('CHENGZI_PLATFORM_API_KEY')`
  解析（账号插件登录后写入；env 未设置时读托管存储），按次计费落在登录账号
- 生成 PNG 写入会话工作区 `chengzi-images/`，模型按 `present` 惯例交付给用户
- 出站仅 https（http 限回环联调）、拒绝内网/保留地址、有界读取

MIT License，参见仓库根 LICENSE 与 THIRD_PARTY_NOTICES.md。
