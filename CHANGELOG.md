# 变更记录

## 2.2.0 — 工作台深度完善

### 不丢稿

- 切换文件、返回作品总览、新建章节前，若有未保存修改会先确认；确认放弃才清空草稿。
- 新增自动保存（默认关闭，阅读栏可开启）：编辑态停止输入 3.5 秒后保存，偏好存 `localStorage` 的 `dsh-creator:autosave`。
- 新增 `beforeunload` 未保存提示，避免直接关闭页面丢稿。

### 不覆盖

- 保存新增内容指纹 `baseHash` 与 fs 版本守卫：打开文件时记录指纹，保存时若磁盘内容已被助手或另一个窗口改动，Host 返回 `409 conflict`，不再静默覆盖。
- 冲突弹窗提供「重新加载 / 覆盖保存 / 取消」；`force: true` 才允许显式覆盖。
- `scaffold` 对已初始化工程返回 `409 already-initialized`，避免重复初始化覆盖正文与设定；工作台与 `creator_project` 工具都加了这个保护。
- 整理索引前先读取旧 README，保留作者写的 `- 简介：` 与 `- 状态：`，不再清空。

### 找得到

- 新增全文检索 `POST /creator-workbench/v1/api/search`：搜索正文/大纲/设定集/人物卡/归档与 README/伏笔/时间线/文风卡，返回路径、行号与上下文片段。
- 工作台导航新增搜索框与结果列表，点击结果直接打开文件；上限 60 条结果 / 400 个文件 / 单文件 20 万字符。

### 工程内核

- `project-core` 新增 `hashText()`（FNV-1a 32 位，前后端同实现）、`searchProject()`、`readmeMeta()`、`writeGuarded()`。
- `creator_project` 的「初始化工程」默认拒绝覆盖已有工程，`force: true` 才重建。
- 保存路由保留旧 `write()` 返回相对路径的兼容行为，新增 `hash / operation / lint` 返回字段。

### 测试

- 工作台测试从 19 项增至 23 项：覆盖保存冲突 409、`force` 覆盖、全文检索行号、重复初始化 409、README 简介/状态保留、`hashText` 稳定性与 `readmeMeta`。
- `npm test`：规则 51、工具 14、工作台 23，全 PASS。

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
