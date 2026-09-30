# dsh-plugin-chengzi-brand

橙子PRO 的浏览器品牌占位插件。填充壳层声明的通用品牌槽位——侧栏品牌行
（`sidebar.brand.mark`、`sidebar.brand.name`）与空白会话 hero 位
（`conversation.hero.brand.mark`）——内容为橙子切片标识（品牌主色
`#E8732A`）与「橙子PRO」字标。

注册使用遮蔽优先级 `-1`：在 official 构建下稳定遮蔽官方鲸鱼字标
（`@deepseek-ai/dsh-client-ui-brand-official` 以默认秩 0 注册）而不冲突；
在本地构建（官方插件 no-op）下则是唯一占位。

## 结构

- `src/index.ts` — 空的 node 半面（Loader 宿主行）。
- `src/client/` — 槽位注册与品牌图形组件。
- `tests/` — 注册/遮蔽/渲染冒烟用例（jsdom）。
