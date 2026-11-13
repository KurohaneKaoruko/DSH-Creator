# 架构说明

DSH-Creator 2.x 把项目主体从「一组智能体预设」改成「一个创作工作台 + 多个创作助手」。2.1 完成主体切换，2.2 补了内容指纹、版本守卫与搜索，2.3 补了崩溃恢复、历史快照与整本导出，2.4 补了全书体检、TXT 投稿导出与写作活动统计。本文说明结构、数据流和扩展方式。

## 为什么不再以预设为主体

预设回答的是「AI 以什么身份、带什么工具和技能工作」，它不提供界面。此前的版本把四个预设当产品目录，小说编辑器是另一个可选 bundle；结果是：

- 用户要装两次，工作台和助手可能版本不一致；
- 编辑器自己解析工程文件、自己统计章节，和 `creator_*` 工具的实现会漂移；
- 预设切换藏在新建会话流程里，写作过程中换领域要重开会话。

2.1 的答案是：**工作台是产品表面，预设是工作台里的角色**。一次安装得到两者，工程约定只有一份实现。

## 四层结构

| 层 | 位置 | 职责 | 是否调用模型 |
| --- | --- | --- | --- |
| 工作台 | `plugins/workbench/` | 工程导航、阅读/编辑、进度、检查面板、全书体检、活动统计、工程操作 | 否 |
| 助手 | `cordis.patch.yml` 的四个 `@deepseek-ai/dsh-agent-preset` | 领域人设、工作流路由、风格纪律 | 是（对话时） |
| 工具 | `plugins/creator-tools.mjs` | lint、名词核对、写前材料、归档、工程 CRUD、导入、体检材料 | 否 |
| 方法论 | `skills/` | 拆书、大纲、场景、连续性、去 AI 味、文风等流程知识 | 否（按需加载） |

工作台与工具共用 `plugins/project-core.mjs`：

```
project-core.mjs
  ├─ 目录约定 PROJECT / SCAFFOLD_FILES
  ├─ 章节命名 chapterFile / parseChapterFile
  ├─ 打开工程 openProject（读/列/写/章节定位）
  ├─ 初始化 scaffold、保存 saveChapter、索引 rebuildIndex
  ├─ 统计 projectStats（章节、字数、篇幅分布、伏笔、目录）
  ├─ 伏笔体检 auditForeshadow
  ├─ 全书体检 scanBook（游标分批，逐章跑 lint）
  ├─ 纯文本转换 toPlainText（Markdown → TXT 投稿格式）
  └─ 活动统计 activityReport（快照+mtime 推每日保存/新增/连续天数）
```

`creator_project` 与工作台的 `/stats`、`/scaffold`、`/new-chapter`、`/index` 都调用这一份代码，所以工作台总览和工具输出的「第几章、多少字、哪些伏笔悬空」不会对不上。

## 组装方式

`package.json` 声明两件事：

- `dsh.bundle.patch` → `cordis.patch.yml`：宿主插件行 `creator-workbench`，加四个助手预设；
- `dsh.client`（`platform: web`, `immediately: true`）→ `exports["./client"]` 指向工作台前端，由 DSH 客户端构建加载。

工作台是**宿主级插件**，不挂在任何预设里：

- 预设切换不会卸载工作台；
- 没有 `webServer` 的宿主（ACP、纯终端）里，`apply` 只监听服务事件、不注册路由，保持静默；
- Web 宿主在 `webServer` 出现后才注册 `/creator-workbench/v1/api`。

前端注册在 `conversation.view` 槽，从视图 props 的 `sessionId` 取得会话 ID（这是 2.1 修掉的一个旧 bug：旧编辑器切助手时没有会话 ID，`agentPresets.select` 调用必然失败）。

## 数据流

**读**：浏览器 → `ctx.remote.workspaceFiles`（官方 Remote）→ Host 组合文件系统。`read` 返回 `RemoteResult`，取 `{eof, offset, lines, text}` 分页读完。2.1 修掉了旧编辑器直接把 RemoteResult 当文件对象读取的问题。

**写**：浏览器 → `POST /creator-workbench/v1/api/save` → Host：

1. 从 `ctx.sessions.get(sessionId).header.cwd` 取当前会话工作区；
2. 归一化相对路径，拒绝绝对路径、盘符、`../`；
3. `path.resolve(cwd, rel)` 必须落在 `cwd` 内；
4. 只允许 `.md`，正文上限 8 MiB；
5. 若客户端带 `baseHash`，先读当前落盘文本并比对指纹；不一致返回 `409 conflict`，不写入；
6. 手工保存（`history: true`）且旧文本非空时，先把旧文本写入 `.history/<原路径>/YYYYMMDD-HHMMSS-xxxx.md`；自动保存不生成快照；
7. 用 `ctx.fs.stat` 的版本做 `replaceIfVersion` / `createIfAbsent` 守卫写入；保存瞬间被抢写也转 `409 conflict`；`force: true` 才显式覆盖；
8. 经 `ctx.fs.writeText(..., sandboxPolicy.resolve({session}))` 写入，返回新 `hash`、`operation`、`snapshot` 与 `lint`。

保存成功后同一请求内跑 `lintText`，把硬/软违规返回前端；工作台是人工编辑通道，**不阻断保存**，但会把问题摆在右侧。走 `creator_project` 保存则保留门禁：硬违规拒收，除非 `force: true`。

**草稿保护**：前端在打开文件时记录 `hashText`，切换文件/返回总览/新建章节前确认未保存修改；可选 3.5 秒自动保存；`beforeunload` 提示关闭页面。保存期间继续输入不会被误标为已保存。

**崩溃恢复**：编辑态停顿 0.8 秒把草稿写入 `localStorage`（`dsh-creator:draft:<sessionId>:<path>`），`beforeunload` / `pagehide` 再同步一次；重开文件时若本地草稿与磁盘不同，确认后恢复为编辑态，并继续受 `baseHash` 冲突保护。保存成功或明确放弃时清除缓存。

**历史版本**：`POST /creator-workbench/v1/api/history` 列出 `.history` 下的快照，`POST /creator-workbench/v1/api/restore` 恢复指定快照；恢复前先把当前磁盘内容存一份快照，写入仍走版本守卫。每个文件最多保留 40 个快照。

**整本导出**：前端按 `stats.chapters` 顺序通过 `workspaceFiles.read` 读取正文，拼接为单个 Markdown 并触发浏览器下载；单个文件读取失败不阻断其余章节。TXT 导出复用同一份逐章读取循环，转换在前端本地完成（`toPlainText` 与内核同一实现，测试锚定前后端输出一致）：章节标题独立行、去 Markdown 格式保文字、空行分段。

**全书体检**：`POST /creator-workbench/v1/api/scan` → `scanBook` 游标式分批——每次只读 `offset` 起的 `batch`（默认 10）章正文，逐章跑 `lintText`，返回按章汇总的硬/软违规与 `next` 游标（读完为 null）。前端循环调用、每批边扫边渲染、可随时停止且已扫结果保留，几百章的工程不会一次性全量读入卡死 UI；问题章条目点击直达对应章节。

**写作活动统计**：`POST /creator-workbench/v1/api/activity` → `activityReport`（只读）——保存次数取 `.history` 快照名自带的时间戳（手工保存一条，自动保存不产生）；新增字数取相邻快照的体积近似差（快照缺体积时补 stat，仍取不到按 0）；写作日为快照日期 ∪ 章节文件 mtime 日期；连续天数从今天往回数到第一个空日。全部读取失败按空数据处理，前端渲染优雅空态。

**全文检索**：`POST /creator-workbench/v1/api/search` → `searchProject` 遍历正文/大纲/设定集/人物卡/归档与 README/伏笔/时间线/文风卡，返回 `{path,line,preview}`；上限 60 条结果、400 个文件、单文件 20 万字符。

**其他操作**：`/scaffold`、`/new-chapter`、`/index`、`/stats` 都先解析会话工作区，再调用 `project-core`。`/scaffold` 对已有工程返回 `409 already-initialized`；`/index` 先读取旧 README，保留作者写的简介/状态再重建。

## 安全边界

- 工作台写入只能落在**当前会话工作区**内；客户端不能指定任意服务器路径。
- 路径分隔符统一按 `/` 归一化，Windows 盘符也拒绝。
- 非 `.md` 一律拒绝（避免借工作台写脚本或配置）。
- 单请求 8 MiB 上限，超限直接断开。
- 工作台不读取工作区以外的文件；`workspaceFiles` 自身有沙箱边界。
- 工作台不提供「执行命令」「打开外部链接」能力，只做文本与工程文件。

## 扩展指南

### 加一个创作助手

1. 在 `cordis.patch.yml` 复制一个 `preset-*` 块，改 `config.id` / `name` / `description` / `order`；
2. persona 里保留「工作台约定」段（接手先读当前文件、工作台保存不过门禁）；
3. 插件行直接引用已有的锚点，保持工具与 skills 一致；
4. 在 `plugins/workbench/client.js` 的 `ASSISTANTS` 里加一项（id、短标签、全名），工作台顶部页签即可切换；
5. 更新 `tools/verify-bundle.mjs` 的 `EXPECTED_ASSISTANTS` 与 README 表格。

### 加一个工作台操作

1. 在 `project-core.mjs` 写纯函数（输入 `io`，输出可 JSON 化结果）；
2. 在 `plugins/workbench/index.js` 的 `handle` 加一个 `case`，先 `sessionOf`，再调用纯函数；
3. 在 `client.js` 加按钮与 `api(action, payload)` 调用；
4. 在 `tools/test-workbench.mjs` 加一条路由断言（含拒绝路径的用例）。

### 加一条正文规则

只改 `plugins/lint.mjs`，同步在 `tools/test-lint.mjs` 加「应命中」与「不应误报」两侧用例。`creator_lint`、`creator_project` 的保存门禁、工作台检查面板会自动共用新规则。

### 加一个 skill

在 `skills/<name>/SKILL.md` 写方法论，在对应助手的 skill 路由段加一行触发条件。工作台不需要改：助手按需加载。

## 测试策略

- `test-lint.mjs`：规则命中/误报/结构稳定，含伏笔体检。
- `test-tools.mjs`：七个工具在真实临时目录里的工程流转（初始化、门禁、写前材料、统计、导入、归档、体检）。
- `test-workbench.mjs`：Host 路由（webServer 延迟注册、scaffold→新章→保存→stats→index、越界/非 md/未知会话拒绝、撞号 409、全书体检分批与越界 offset、活动统计窗口与空态），以及包结构、Client 语法与槽注册（含 2.4 前端入口与前后端纯文本转换一致性）。
- `verify-bundle.mjs`：真实 DSH 内核安装 bundle，断言四个助手 roster 无 broken、diagnostic 全空、scope 挂载成功、18 个 skill 被发现、工作台 Host/Client 与 `dsh.client` 落位完整。

改任何一层，先跑前三项；改安装形态或 patch，再跑第四项。
