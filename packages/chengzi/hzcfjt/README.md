# dsh-plugin-chengzi-hzcfjt

橙子PRO 定制 agent 工具：`generate_hzcfjt_ppt` —— 广州市海珠城市建设发展集团
有限公司（海珠城发集团）工作汇报 PPT 生成器。

- 自然语言激活，纯 host 侧，无客户端界面；按客户五章节汇报模板校验并渲染
  slides[]，生成真实 .pptx 落到会话工作区（`chengzi-ppt/`），模型按 `present`
  惯例交付。
- **固定头部**：成品前 6 页（封面 + 一、整体概况）逐字节使用客户审定的原版
  页面（`assets/hzcfjt-head.pptx`，logo 与图片完全一致）；动态章节从第 7 页
  （二、产业投资）开始追加。
- 配图联动：先调用 `generate_image` 生成图片，再把返回的 `file_path` 填入
  slides 对应页的 `image` 字段，本工具读入并嵌入 PPT。

模板事实源：海珠城发《PPT 模板》文档（五大章节 + 企业单页/重点项目单页/
数据大屏三类高复用页面），代码化于 `src/template/haizhu.ts`。
