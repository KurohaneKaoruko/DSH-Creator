# DSH-Creator · 创作助手

一个 DeepSeek Harness 智能体预设 bundle，把 DSH 升级为**一站式文本创作平台**：小说、短剧/影视剧本、游戏剧本、通用文本创作，四个领域助手 + 一套零模型工具链 + 可选 Web 创作工作台。

## 平台构成

**4 个领域预设**（新建会话时任选，各自独立人设与领域铁律）

| 预设 | 面向 | 核心纪律 |
| --- | --- | --- |
| 小说助手 | 中文网络小说长篇 | 2000–4000 字/章、章末钩子、伏笔体检、6 风格 skill |
| 编剧助手 | 竖屏短剧/影视剧本 | 前 3 秒钩子、每 30 秒冲突升级、场景/动作行/对白格式 |
| 游戏剧本助手 | 游戏叙事 | 对话树节点 ID、flag 一致性、任务目标可操作 |
| 通用创作助手 | 文案/诗歌/漫画脚本/播客稿等 | 先问用途受众、载体裁切、领域路由建议 |

**7+7 个工具**（纯代码实现，零模型调用；`creator_*` 主名 + `novel_*` 兼容别名）

| 工具 | 用途 |
| --- | --- |
| creator_lint | 正文检查：标点纪律、禁用词、频次、句式、AI 味三代特征等 41 项规则 |
| creator_check | 名词一致性核对：找出正文反复出现却未建档的高频词 |
| creator_briefing | 写前材料组装：前 10 章结尾、人物卡、伏笔体检、时间线、文风卡 |
| creator_archive | 归档三件套落盘（格式校验拒收） |
| creator_project | 工程操作：初始化、保存章节（内置质量门禁）、进度统计 |
| creator_import | 旧稿分章导入（撞号保护） |
| creator_scan_book | 全书体检材料组装 |

**18 个方法论 skill**（12 方法论 + 6 文风，四预设共享；以 submodule 挂载于独立仓库 Novelist-Skills，克隆请带 --recurse-submodules）

**可选 Web 创作工作台**（[plugins-dsh/novel-editor/](plugins-dsh/novel-editor/)，独立 bundle 按需安装）
- 整页「创作工作台」视图：顶部领域页签一键切换助手，左侧章节列表、右侧阅读/编辑双栏并排
- 小说排版渲染（`第X章` 居中、对话高亮、双链、字数统计）+ 编辑保存回工作区

## 安装

把本仓库交给任意 DeepSeek Harness Agent：「请按 INSTALL.md 把 Creator 安装到当前环境」。手动安装见 [INSTALL.md](INSTALL.md)。

> Web 工作台 [dsh-novel-editor](plugins-dsh/novel-editor/) 与预设不捆绑、单独安装；Agent 安装预设时会按 INSTALL.md 询问是否一并安装。

## 开发与验证

改完人设 / 工具 / skill 后，先跑规则单测（`cd tools && npm test`，正文引擎 51 项 + 工具集成 14 项），再用钉版内核冒烟验证安装路线（`npm run verify:bundle`）。

检查引擎住在 `plugins/lint.mjs`（`creator_lint` 与保存门禁共用同一份实现），规则判定由 `tools/test-lint.mjs` 钉住——改规则时同步加用例，并做一次证伪（把规则改坏，确认用例翻红）。

## 参考来源与致谢

- 部分 AI 味量化指标（副词频次、句长波动、同句式连用、对话标签密度等）的设计思路参考 MIT 开源项目 [chinese-webnovel-skills（网文工坊）](https://github.com/tance-mang/chinese-webnovel-skills)，`creator_lint` 的规则实现为本项目独立编写，未复制其代码。
- 预设与插件的运行形态、验证工具链基于 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的 agent-preset / plugin 机制。

## 许可证

[MIT License](LICENSE) © 2026 KurohaneKaoruko
