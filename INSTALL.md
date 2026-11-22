# 安装指引

本文件描述如何把 **DSH-Creator 创作工作台** 安装到 DeepSeek Harness。只装一个 bundle：工作台 + 四个创作助手 + 工具 + skills 一次装齐。

Agent 请按顺序执行；手动安装按同样步骤操作。

## 0. 环境确认

- DSH **≥ 0.2.2-rc.2**（需支持根作用域会话列表与侧栏全局面板插槽；当前实测版本为 0.2.2-rc.2）。
- **Web 端**或桌面端（桌面端使用内嵌 Web 视图）。工作台是 Web 插件；ACP、纯终端宿主没有 `webServer`，工作台 Host 会静默不注册路由，助手仍可正常使用。
- 判断不了版本时：查看 `dsh --version` 或桌面端版本信息；仅有插件管理器不代表已支持工作台所需的全局面板插槽。

升级前可在仓库 `tools/` 目录执行兼容性预检（把版本替换为 `dsh --version` 的版本号，并按插件管理器当前 bundle 列表填写已安装项）：

```bash
node check-compat.mjs --dsh-version 0.2.2-rc.2 --installed-bundles dsh-creator,dsh-novel-editor
```

预检会阻止低于最低版本或重复安装 `dsh-creator`，并提示卸载旧版 `dsh-novel-editor`；不读取或修改作品目录。

> 不再有「可选插件」步骤。小说编辑器已并入主 bundle，独立安装 `dsh-novel-editor` 会得到重复的工作台入口。

---

## 1. 取得仓库

```bash
git clone https://github.com/KurohaneKaoruko/DSH-Creator.git
```

无需 `--recurse-submodules`：`skills/` 已并入主仓库，没有子模块。记下仓库绝对路径（下称 `<仓库目录>`）。

## 2. 安装 bundle

任选其一：

- **桌面端**：插件管理器 → 安装 bundle → 目标填 `<仓库目录>`；
- **Agent**：`plugin_manager`，`action: install_bundle`，`target: <仓库目录>`；
- **CLI**：`dsh plugin --profile <profile名> add <仓库目录>`。

工具会完成包安装与 bundle 选择，不要手工改 profile 的 `package.json` 复刻这些步骤。

## 3. 挂载校验

1. `list_bundles` 列出 `dsh-creator`；
2. `list_plugins` 有 `creator-workbench` 与 `preset-novelist` / `preset-screenwriter` / `preset-gamescript` / `preset-general` 五行，且**无激活诊断**；
3. roster（预设选择器）出现「**小说助手 / 编剧助手 / 游戏剧本助手 / 通用创作助手**」四项。

> `creator-workbench` 在没有 Web 宿主的 profile 里保持静默（不注册路由、不报错），这是预期行为。

## 4. 验证助手

新建会话任选一个助手，确认：

- 工具列表包含 `creator_lint` / `creator_check` / `creator_briefing` / `creator_archive` / `creator_project` / `creator_import` / `creator_scan_book`（及 `novel_*` 兼容别名）；
- 技能列表包含 18 个 `novel-*` skill（四个助手共享）；
- 系统提示包含所选领域的人设与工作台约定。

## 5. 验证工作台

重启 DSH（首次安装后前端需要重建）。打开任意带工作区的会话，头部页签应出现「**创作工作台**」（与「对话」并排）。点击后从上方会话选择器选定一个有工作区的会话，进入后：

1. 顶部四个助手页签可切换；
2. 未初始化时显示「还没有作品工程」，输入作品名 → **新建工程**；已有工程再次点新建会被拒绝，不会覆盖正文；
3. 点「新建章节」创建第 001 章，阅读/编辑并保存；
4. 点「检查」能看到硬违规 / 建议项分列；
5. 点「整理索引」后，`README.md` 里出现章节双链，且原有的「简介 / 状态」仍保留；
6. 在左侧搜索框输入至少 2 个字，能看到带路径、行号、上下文的结果，点击直达；
7. 开启「自动保存」后停止输入约 3.5 秒，按钮从「保存」变为「已保存」；若同时在外部改同一文件再保存，应弹出「文件已被外部修改」的三选一对话框；
8. 编辑后手工保存两次，点阅读栏「历史」应看到至少一个快照，点「恢复」能回到旧版本，且恢复前会先给当前内容留快照；
9. 在总览点「导出全本」，应下载一个包含全部章节的 Markdown 文件；
10. 编辑中直接刷新页面，再打开同一章，应提示「检测到未保存草稿」，确认恢复后内容仍在；
11. 编辑中从顶部选择器切换到另一工作区会话，应先暂存本机草稿并询问确认；返回原会话后应可恢复，保存仍受原文件版本指纹保护。

工作台的保存路由只写**当前会话工作区内**的 `.md` 文件，路径越界、绝对路径、非 `.md` 都会被拒绝；单次请求上限 8 MiB。保存带内容指纹与版本守卫，冲突时返回 `409 conflict` 而不是静默覆盖。手工保存的历史快照存放在工程根目录的 `.history/`，每个文件最多保留 40 个。

### 发布候选人工验收（自动测试不能替代）

- [ ] 在受支持的 DSH Web/桌面版本打开会话内工作台，确认视图页签与工程导航正常。
- [ ] 编辑章节后切换会话，分别验证确认、取消、返回旧会话恢复草稿和外部修改冲突。
- [ ] 升级既有 dsh-creator 工程，确认作品文件未移动或覆盖；如果旧 `dsh-novel-editor` 同时安装，确认可见迁移提示并移除旧入口。
- [ ] 卸载/停用 bundle 后重启宿主，确认旧工作台入口清理、作品文件保留。

当前仓库自动化包含 Host/Client 测试、包清单检查和 ACP 真实内核冒烟；上述 Web/桌面入口、升级与卸载检查需要在实际 DSH 宿主完成，未走查前不得标记为人工验收通过。

## 卸载

- 插件管理器移除 / 停用 `dsh-creator` bundle。
- 若曾单独安装 `dsh-novel-editor`：一并移除，否则会残留重复的「创作工作台」入口。
- 若曾用 `dsh-novelist`：一并移除或禁用旧 bundle。

## 常见问题

- **预设选择器里没有四个助手？**
  确认 `list_bundles` 列出了 `dsh-creator`、`list_plugins` 的 `preset-*` 四行无激活诊断；安装目标必须是**包含 package.json 的仓库根目录**。

- **会话头部没有「创作工作台」页签？**
  先确认打开的是 Web 端 / 桌面端，而不是纯终端或 ACP 宿主；再确认 `package.json` 里的 `dsh.client` 声明未被裁剪，且安装后重启过 DSH。开发者可在浏览器访问 `/creator-workbench/v1/api/health` 检查 Host 是否挂上。

- **工作台提示「宿主未就绪」？**
  说明前端在，但 Host 路由没注册：通常是 `creator-workbench` 行未激活，或当前宿主没有 `webServer`。查看 `list_plugins` 的诊断信息。

- **切换助手后行为没变？**
  `agentPresets.select` 会改写当前会话的预设；会话正在生成时切换可能被拒。等当前回复结束后再切换，或新开会话。

- **旧会话里 `novel_lint` 还能用吗？**
  能。7 个工具同时注册 `novel_*` 兼容别名，旧提示词平滑过渡。

- **skills 怎么改？**
  `skills/` 已在本仓库内，直接改、提交、重装 bundle（或重启）即可，不再需要跟进子模块指针。
