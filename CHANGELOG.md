# Changelog

## 0.2.0-rc.1 — 2026-11-13

内部 tarball 预发布，兼容 DSH 0.2.1-rc.5 / Node >=24.9。未发布公共 npm 包。

- 自动回收失效 writer lock；中断 attempt 保留失败原因和文件。
- start/resume 支持 attach 磁盘项目；reconcile 可显式解除 blocked 状态，保留原 deadline 和有界尝试预算。
- 暂停保留可复用会话；新 executor attempt 从前一次工作目录接续，不污染 Reviewer 工作目录。
- Producer 允许 compaction/pruning；历史丢失时明确记录 contextLoss，降级文件/README 交接。
- Task 支持 timeoutMinutes；会话 continuation 更新 timer，跨任务 producer deadline 不必相等。
- 数值执行与审核 prompt 要求真实数组、收敛/守恒/误差指标及独立验证，禁止 mock、曲线拟合冒充求解和静默参数降级。
- 简化文件访问与 bash preflight；保留路径边界、符号链接检查、SHA256 和封存权限。
- 错误不再仅显示泛化拒绝，命令日志保留实际信息/堆栈并脱敏凭据。
- 发布前 scripted/native 工程回归：221 tests，通过；未调用付费模型，不作为科学复现验收。
- 新增安装说明、Agent 安装 prompt、示例和 prepack 测试门禁。

已知边界：宿主重启不恢复完整内存 transcript；未做完整 tsc 类型检查；未验收 macOS/native Windows 工具链；没有跨版本状态迁移保证；不提供网络、凭据或多租户隔离。
