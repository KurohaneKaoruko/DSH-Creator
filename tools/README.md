# tools/ —— 创作工作台验证工具链

改完工作台（Host / Client）、助手人设、工具或 skill 之后，用这里的三层测试 + 真实内核冒烟确认没有回归。不需要 API Key，不发起 LLM 调用。

```bash
npm test                 # 规则 51 + 工具集成 14 + 工作台 24（秒级，不装内核）
npm run kernel:install   # 安装验证内核 tools/kernel-bundle/（@deepseek-ai/dsh@0.2.2-rc.2）
npm run verify:bundle    # 真实内核：四助手挂载 + 工作台落位 + 18 skills 发现
```

## 三层不依赖内核的测试（npm test）

**`test-lint.mjs` —— 规则单测**

直接 import `plugins/lint.mjs` 与伏笔体检函数：

- 正向：每条硬规则、主要软规则至少一例；
- 反向：干净稿不许报硬违规，也不许误报主要软规则；
- 回归：修过的判定缺陷单独留用例（连续同句式开头误报首句人称、长短禁词重叠重复计数、Markdown 残留只匹配首行）。

**`test-tools.mjs` —— 工具层集成**

用 `node:fs` 实现最小的 `fs` / `sandboxPolicy`，调用 `apply(ctx)`，把 7 个工具当函数跑在临时目录：初始化骨架 → 保存门禁拦截/放行 → 写前材料 → 进度统计 → 导入撞号保护 → 归档格式校验 → 全书体检材料。

**`test-workbench.mjs` —— 工作台 Host 路由 + 包结构**

用最小的 `fs` / `sessions` / `sandboxPolicy` / `webServer` 替身调用 `apply(ctx)`，把 prefix 路由当 HTTP handler 跑：

1. `webServer` 已存在 / 后出现（`internal/service`）都能注册；
2. 空工作区 → scaffold → 新建章节 → 保存 → stats → index 全流程；
3. 带硬违规仍保存，但返回检查结果（人工编辑不被门禁拦截）；
4. `../`、绝对路径、非 `.md`、未知会话全部拒绝且不落盘；
5. 保存指纹冲突 409、`force` 覆盖、全文检索、重复初始化 409、README 元信息保留；
6. 手工保存快照 → 历史列表倒序 → 恢复回滚，且恢复前给当前内容留快照；
7. 包结构：无独立 `plugins-dsh`、`dsh.client`/`exports` 指向工作台；
8. Client 源码 `node --check` 可解析，注册在 `conversation.view`，含崩溃恢复/历史/导出入口。

改规则、工具或路由时同步加用例，并做一次证伪：把实现临时改坏，确认用例翻红后再还原。

## 真实内核冒烟（verify:bundle）

`verify-bundle.mjs` 把仓库根目录以 `file:` 依赖装进一个临时 profile（模拟插件管理器 `install_bundle` 的落位），用真实 DSH 内核启动，并由组合内探针 `creator-probe` 断言：

1. **roster**：`novelist` / `screenwriter` / `gamescript` / `general-creator` 四项都在，无 `broken`，显示名为「小说助手 / 编剧助手 / 游戏剧本助手 / 通用创作助手」；
2. **挂载诊断**：四个预设的 `diagnostic` 均为空（行级 import 与 config 全部通过——「session/new 成功」不构成证据）；
3. **scope 挂载**：`acquireScope('novelist')` 成功，`skills.list({cwd, scope})` 能发现 18 个 `novel-*`；
4. **落位文件**：`plugins/workbench/index.js`、`client.js`、`locale/`、`plugins/project-core.mjs`、`skills/novel-craft/SKILL.md` 都在安装副本里；
5. **前端声明**：`package.json` 的 `dsh.client.platform === "web"`。

改断言后务必做一次证伪（把安装副本改坏，确认判定翻转为 FAIL）。

## 产物与版本

- 验证 HOME 在 `tools/.testhome*/`，内核在 `tools/kernel-bundle/`，均不入库。
- 内核钉在 `package.json` 的 `kernel:install`（`@deepseek-ai/dsh@0.2.2-rc.2`）。
- 兼容分界线（实测）：persona 键名 `text`→`prefix` 在 0.1.2→0.1.3-alpha.2；预设安装机制（目录→bundle）在 0.1.6-alpha.2→0.1.7-alpha.1。本项目只维护 bundle 路线。
- CI 在 `.github/workflows/verify.yml`：push 自动跑 `npm test` 与 `verify:bundle`。
