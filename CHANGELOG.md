# 变更记录

## 2.1.0 — 工作台成为主体

### 定位重构

- 项目从「四个智能体预设 + 可选编辑器」改为「一个创作工作台 + 四个创作助手」。
- 小说编辑器（原 `plugins-dsh/novel-editor` 独立 bundle）并入主包 `plugins/workbench/`，一次安装，不再单独安装。
- 四个助手仍是预设，但只作为工作台里的角色存在；README / INSTALL 不再以预设为产品目录。

### 工作台（原编辑器升级）

- 新增作品总览：章节数、总字数、平均篇幅、未回收伏笔、偏短/空章节与缺失档案提醒。
- 新增工程导航：正文 / 大纲 / 设定集 / 人物卡 / 归档 / 追踪文件，来自 `/stats` 一次拉取。
- 新增一键工程操作：新建作品工程、新建下一章（自动续号、撞号拒收）、整理作品索引。
- 新增右侧检查面板：保存/检查后列出硬违规与建议项；保存是人工编辑通道，不阻断但返回检查结果。
- 新增助手页签：从 `conversation.view` 的视图 props 取会话 ID，调用 `agentPresets.select` 真正切换预设。
- 新增快捷指令：写下一章 / 修本章硬违规 / 全书体检 / 补本章归档，复制到对话框。
- 保留小说排版（章节标题居中、对话高亮、双链）、字数、字号、`Ctrl/Cmd+S` 保存。

### 修复

- **RemoteResult 解包**：官方 `workspaceFiles.read/list` 返回 `{ok, value}`，旧编辑器直接读 `text/entries`，在 0.2.x 上必失败。工作台统一 `unwrap()`，读文件按 `{offset}` + `eof` 分页读完。
- **切换助手缺少会话 ID**：`agentPresets.select(agentId, presetId)` 需要两个参数；旧代码只传预设 ID。改为从视图 props 的 sessionId。
- **保存路由路径失锚**：旧编辑器把相对路径直接交给 `fs.writeText`，会落到宿主进程 cwd。现在从 `sessions.get(sessionId).header.cwd` 取工作区，`path.resolve` 后强制落在 cwd 内，并拒绝绝对路径、盘符、`../`、非 `.md` 与 >8 MiB 请求。
- **助手名单变化**：`agentPresets.list()` 返回 `{presets}` 且字段为 `name`；兼容 `displayName`/`label`。
- **工作台在非 Web 宿主**：`webServer` 未出现时不注册路由、不报错；出现 `internal/service` 事件后再补注册。
- **前端 client 未加载**：`dsh-client-modules` 只扫描包根形态的 Loader 行；工作台行若写成 `dsh-creator/plugins/workbench/index.js`，`dsh.client` 永远发现不到。改为包根 `dsh-creator`（`exports.'.'` 指向 Host）。
- **0.2.2 兼容**：`@deepseek-ai/dsh-tool-subagent-control/list-agents` 子路径在 0.2.2 已并入主包，旧行会让四个预设全部 `never started`。删除该行，`list_agents` 由 `tool-subagent-control` 主插件注册。

### 工程内核

- 新增 `plugins/project-core.mjs`：目录约定、章节命名/解析、脚手架、保存、统计、索引、伏笔体检。
- `creator_project` 与工作台的 `/scaffold`、`/new-chapter`、`/stats`、`/index` 共用这份实现，删掉两份重复代码。
- `scaffold` / `rebuildIndex` 成为纯函数，工作台不再依赖模型就能建工程、整理索引。

### 仓库与安装

- 删除 ≤ 0.1.6 的目录式安装路线：`agent.cordis.yml`、`preset.yml`、`provision-home.mjs`、`verify-kernel.mjs`、`verify-acp-live.mjs`、`tools/kernel/`。
- `skills/` 正式并入主仓库，删除 `.gitmodules`，克隆不再需要 `--recurse-submodules`。
- `package.json` 升级到 2.1.0：新增 `dsh.client`（platform web, immediately）与 `exports`（`.`、`./client`、`./icon`、`./locale/*.json`、插件子路径）。
- bundle patch 新增宿主级 `creator-workbench` 行；四个助手预设保留，人设加入「工作台约定」段。
- CI 改为「三层测试 + 0.2.2 bundle 冒烟」，移除目录式路线。

### 测试

- 新增 `tools/test-workbench.mjs`（19 项）：webServer 延迟注册、scaffold→新章→保存→stats→index 全流程、路径越界/绝对路径/非 md/未知会话拒绝、撞号 409、包结构、Client 槽注册。
- `verify-bundle.mjs` 升级：断言四个助手 roster 无 broken、四个 diagnostic 为空、scope 挂载、18 个 skill、工作台 Host/Client/locale/工程内核落位、`dsh.client` 声明。
- 现有规则 51 项、工具集成 14 项保持通过。
