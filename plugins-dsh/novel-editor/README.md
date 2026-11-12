# dsh-novel-editor · 小说编辑器

为小说写作优化的 Markdown 阅读与编辑插件（DSH Web）。小说助手（dsh-novelist）的**可选伴侣**，不与预设捆绑——单独安装、单独启用，不装它预设功能也完整。

## 功能

- **整页阅读视图**：会话视图切换器新增「小说编辑器」视图（与轨迹/工作区视图并列），点开整页编辑器；左侧章节文件列表，右侧正文
- **小说排版**：`第X章` 标题居中放大、正文段首缩进两字符、行距 1.9、字号 14–24 可调
- **对话高亮**：弯双引号 ``""`` 内的对话以强调色渲染，扫一眼就能看清对白分布
- **双链支持**：`[[伏笔清单]]` 等 Obsidian 双链渲染为虚线链接样式（与工程约定一致）
- **字数统计**：按 CJK 字符 + 英文单词计数，文件级实时显示
- **编辑与保存**：阅读/编辑双模式切换；编辑后保存回工作区文件（仅 `.md`，走 Host 沙箱文件系统，保留工作区边界）
- **右侧栏预览增强**：右侧栏打开 Markdown 时以小说排版渲染（注册 `sidebar.right.tab.document` 的 `markdown-novel` 实现）

## 安装 / 卸载

独立 bundle，与小说助手分开安装：

- **Agent**：让任意 DSH Agent「把 `plugins-dsh/novel-editor` 安装为 bundle」；
- **插件管理器**：安装 bundle，目标填 `<仓库>/plugins-dsh/novel-editor`；
- **CLI**：`dsh plugin --profile <profile> add <仓库>/plugins-dsh/novel-editor`。

卸载：插件管理器移除 `dsh-novel-editor` bundle。

## 设计边界

- 读文件走官方 Remote 通道（`workspaceFiles`），写文件走本插件 Host 侧 `/novel-editor/api/save` 路由（限制 `.md`、8 MiB 上限、整文件写入），无第三方依赖、无构建步骤。
- 纯客户端渲染（React 来自宿主模块表），样式只用 `--dsw-alias-*` 主题 token，自动跟随亮暗主题。
- 与 dsh-better-sidebar 无依赖关系；两者同时安装时右侧栏文档预览按宿主选择渲染，互不冲突。
