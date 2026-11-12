# 安装指引

本文件描述如何把 Creator（创作助手平台）安装到 DeepSeek Harness。Agent 请按顺序执行；手动安装按同样步骤操作。

## 0. 环境确认与可选插件询问（Agent 必读）

先确认 DSH 版本（`dsh --version`，或桌面端「关于」页）：Creator 平台要求 **DSH ≥ 0.1.7**（bundle 路线；`agent.cordis.yml` 仅作为 ≤ 0.1.6 目录式区间的小说预设遗留兼容保留，不再维护新功能）。

判断不了版本时：`dsh plugin` 子命令或桌面端「插件管理器」存在即支持 bundle。

**可选插件询问（Agent 安装本预设时必须执行）**：本仓库还带一个**可选** Web 插件 `dsh-novel-editor`（创作工作台：整页多助手切换 + 章节列表与阅读/编辑双栏，见 `plugins-dsh/novel-editor/`）。它与预设**不捆绑**——装不装预设功能都完整。Agent 在开始安装前，必须先问用户一句（用 `ask_user_question` 或等价机制）：

> 「本仓库附带可选插件『创作工作台』（dsh-novel-editor）：一站式创作页面——顶部领域页签切换助手、左侧章节列表、右侧阅读/编辑并排。是否一并安装？」（选项：安装 / 跳过）

- 用户选「安装」：在预设装完并校验后，对 `<仓库>/plugins-dsh/novel-editor` 执行同样的 `install_bundle`（该目录自带 package.json 与 cordis.patch.yml，是独立 bundle）。
- 用户选「跳过」或不回答：**不装**，不追问；收尾报告提一句「可选插件未安装，之后可随时用插件管理器补装」。

---

## 路线 A：bundle 安装（DSH ≥ 0.1.7）

本仓库是一个标准 DSH bundle：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，其中用 `@deepseek-ai/dsh-agent-preset` 声明**四个领域预设**（小说/编剧/游戏剧本/通用创作；persona、工具行、`skills/` 与 `plugins/creator-tools.mjs` 随包分发，skills 已并入主仓库无子模块）。

1. git 克隆本仓库（带子模块）：`git clone --recurse-submodules https://github.com/KurohaneKaoruko/DSH-Creator.git`；已克隆的项目补拉 `git submodule update --init`。记下仓库绝对路径（下称 `<仓库目录>`）。
2. 安装（任选其一）：
   - **桌面端**：插件管理器 → 安装 bundle → 目标填 `<仓库目录>`；
   - **Agent**：调用 `plugin_manager` 工具，`action: install_bundle`，`target: <仓库目录>`；
   - **CLI**：`dsh plugin --profile <profile名> add <仓库目录>`（工具会自己完成包安装与 bundle 选择，不要手工改 profile 的 package.json 复刻这些步骤）。
3. 挂载校验：`plugin_manager` 的 `list_bundles` 应列出 `dsh-creator`；`list_plugins` 应有 `preset-novelist` / `preset-screenwriter` / `preset-gamescript` / `preset-general` 四行且无激活诊断。roster（预设选择器）应出现「**小说助手 / 编剧助手 / 游戏剧本助手 / 通用创作助手**」四项。
4. 新建会话任选一个领域预设，确认：
   - 工具列表包含 `creator_lint` / `creator_check` / `creator_briefing` / `creator_archive` / `creator_project` / `creator_import` / `creator_scan_book`（及 `novel_*` 兼容别名）；
   - 技能列表包含全部 18 个 `novel-*` skill（四预设共享，风格按作品归属加载）；
   - 系统提示包含所选领域的人设与工作法路由段。
5. （若装了工作台）重启 DSH 后打开任意会话，视图切换器应出现「**创作工作台**」。

**从旧版升级**：曾安装 `dsh-novelist` 的，先在插件管理器移除旧 bundle 再装 `dsh-creator`（或两者共存时禁用旧的）；曾复制到 `$DSH_HOME/.agent-presets/novelist/` 的目录式安装不再被读取，可删除。

## 路线 B：目录复制（DSH ≤ 0.1.6，遗留兼容，仅小说预设）

1. 把 `preset.yml`、`agent.cordis.yml`、`plugins/`、`skills/` 复制到 `$HOME/.dsh/.agent-presets/novelist/`。
2. 该区间只提供小说领域（四预设家族需 ≥ 0.1.7 的 bundle 路线）。
3. 挂载校验：通过临时插件注入 `agentPresets` 服务并调用 `agentPresets.standingKeyFor('novelist')`；正常返回即校验通过。

## 卸载

- **路线 A**：插件管理器移除/停用 `dsh-creator` bundle；如有遗留目录 `$HOME/.dsh/.agent-presets/novelist` 一并删除。
- **dsh-novel-editor**（若装了）：插件管理器单独移除该 bundle，与预设互不影响。

## 常见问题

- **预设选择器里没有四个助手？**
  确认 `list_bundles` 列出了 `dsh-creator`、`list_plugins` 的 `preset-*` 四行无激活诊断；安装时目标必须是**包含 package.json 的仓库根目录**。
- **旧会话里 `novel_lint` 还能用吗？** 能——7 个工具同时注册了 `novel_*` 兼容别名，旧提示词与文档平滑过渡。
- **skills 怎么改？** skills 在独立仓库（submodule 挂载于 `skills/`）：在 `skills/` 内提交后，主仓库跟进指针；路线 A 改后重装 bundle 或重启。
