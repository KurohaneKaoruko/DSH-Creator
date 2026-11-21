# OpenSpec 全面迭代实施说明

本文件对应父目录 OpenSpec 变更 `comprehensive-product-iteration`。实现按 P0 可靠性与数据安全 → P1 主工作流 → P2 体验/运营 → P3 发布与商业上线推进；每个切片单独提交、单独验证、可单独回滚，不把未完成的真实 DSH Web/桌面走查写成自动化通过。

## 完成门

- 修改工作台、Host 或安装形态后运行 `cd tools && npm test`；修改 bundle 后追加 `npm run verify:bundle` 和 `npm pack --dry-run`。
- 文档、测试和实现必须同一切片同步；安装最低版本、侧栏入口、会话草稿保护必须保持一致。
- `tools/kernel/` 是本机未跟踪验证目录，永远不加入提交，不用清理命令覆盖。
- 真实 DSH Web/桌面、旧版本升级、安装卸载属于人工门；未走查前只能标记“待真实环境验收”。

## 提交与交接

每个切片使用 Conventional Commit，完成后更新 CHANGELOG、相关 README/INSTALL/ARCHITECTURE 和父目录任务状态；若影响下一步，更新交接说明。失败测试、已知兼容限制和回滚方式必须保留。
