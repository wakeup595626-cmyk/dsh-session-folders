# @dsh-external/dsh-session-folders

> **非官方插件。** 由社区开发者独立编写与维护，与 DeepSeek 官方（`@deepseek-ai/*` 包）无隶属关系，也未获其背书。`lib/` 已随仓库提交，开箱即用，无需构建步骤。

DSH Web 侧栏「会话分组」插件：把对话手动整理进可嵌套、可自定义颜色/图标的文件夹，像文件管理器一样分层显示。

## 功能

- **按工作区内嵌**：文件夹直接挂在**工作区标题行的正下方**（无额外表头，像文件管理器一样）；文件夹归属其创建时所在的工作区（`folder.workspaceId`）。「未分组」区只有在确实有归属于它的文件夹时才出现内容。
- **新建文件夹入口**：**右键工作区标题** →「📁 新建文件夹…」；或工作区 **⋯ 菜单 →「新建文件夹…」**；或空态提示里的链接按钮。
- **文件夹树**：支持多级嵌套（新建/编辑时选择上级，子文件夹继承父级所属工作区）、自定义颜色（预设 + 任意取色）、emoji 图标、折叠状态记忆。
- **四种归组方式**：
  1. 右键任意会话 → 「移动到分组」；
  2. 会话行最右 **⋯（原生菜单）→「移动到分组…」**（注入项；已归组会话额外显示「移出分组」）；
  3. 直接拖拽会话行到文件夹（支持文件夹内拖放排序、文件夹拖入文件夹改父级、拖回「退出分组」区域）；
  4. 批量选择模式（工作区右键或侧栏底部 ☑ 按钮）：勾选多个会话后一次移入。
- **不污染原生列表、不动工作区文件**：已分组的会话从原生列表隐藏，只在文件夹内显示；取消分组即恢复。分组纯属网页端组织方式，不会移动/改动磁盘上任何对话产物。原生搜索、归档等能力完全保留。
- **点击文件夹内会话** = 正常打开该会话（走官方 `ctx.sessions.open`）。

## 数据

- 存储：`~/.dsh/profiles/web/session-folders.json`（host 侧原子写入；可用插件配置 `storagePath` 覆盖）。
- 一个会话同一时间只属于一个文件夹；删除文件夹不会删除对话（会话移回未分组，子文件夹上移一级）。
- 乐观并发：客户端带版本号提交，冲突时自动拉取最新状态。

## 结构

- `src/index.js` — host 半：`/@dsh-external/dsh-session-folders/api`（`GET /state`、`GET /health`、`POST /op`）。零第三方依赖。
- `src/client/index.js` — client 半（CJS 风格）：DOM 注入 + `ctx.sessions`/`ctx.workspaces` 订阅 + `sidebar.footer.action` slot 按钮。
- `scripts/build.sh` / `scripts/build-client.mjs` — 零依赖拷贝构建（host 原样拷贝，client 包 `__ModuleLoader__` 头尾），不需要 DSH_CHECKOUT / tsc / tsdown。

## 构建 / 注入

```bash
bash scripts/build.sh        # 产出 lib/index.js + lib/client.js
```

然后使用 dsh-super-injector 的 `dev_inject_plugin` 热注入（`C:\Users\25653\.dsh\external\dsh-session-folders`）。

## 实现要点

- DOM→会话映射：从行元素沿 `__reactFiber$` 链向上找 `{ node: { id }, onOpen }` props（匹配 ui-workspace `SessionNodeItem`）。
- DOM→工作区映射：projectRow 沿 fiber 链找 `props.group`（`{ key, workspaceId, label, sessions[] }`；`key === ''` 为「未分组」区），由此构建 sessionId→workspaceId 索引。
- 注入点：每个 projectRow 之后各插一个 `.dsf-section`（`row.insertAdjacentElement('afterend')`），MutationObserver 防抖幂等重挂；新建/重挂区块时强制重渲染。
- 原生 ⋯ 菜单注入：capture 阶段监听 `button[aria-label^="会话"][aria-label$="的操作"]` 点击记录会话与按钮位置；独立 MutationObserver 发现新出现的 `div[role="menu"]` 后克隆其末项结构追加注入项，点击时派发 Escape 关闭原生菜单再打开自有选择菜单。
- 隐藏原生行：CSS class（`display:none`）。
- 拖拽：原生行拖拽 payload（`text/plain` = sessionId）+ document 级 capture 监听登记来源。
