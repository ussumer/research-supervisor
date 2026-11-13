# 交给安装 Agent 的 Prompt

将下面全文与 `.tgz`、`SHA256SUMS`、README 一起交给有本机终端权限的 Agent。仅允许安装和零模型调用检查，不授权启动科研任务。

---

请在我的机器上安装 **DSH Research Supervisor 0.2.0-rc.1**。这是 DeepSeek Harness（DSH）的 Cordis 插件，不是 Claude Code 插件。请实际完成安装、配置检查和可行的加载检查，不要只给建议。

## 输入

- 安装包：`<替换为 ddd-research-dsh-research-supervisor-0.2.0-rc.1.tgz 的绝对路径>`
- 校验文件：`<替换为 SHA256SUMS 的绝对路径>`
- 插件 README：随包文档。
- 专用 profile 名：`research-supervisor`（如果已存在，先检查并备份，不覆盖现有配置）。
- 项目状态目录：`<替换为新的绝对路径，与论文和 sources 完全分离>`。

## 执行要求

1. 阅读 README。检查 Node.js >=24.9 和 DSH 0.2.1-rc.5；不得静默升级到 latest。如果缺宿主或版本冲突，说明需要下载/安装什么，经我同意后安装指定版本。已有 DSH 不同版本时优先独立安装，不能覆盖正在使用的宿主。
2. 检查 tarball 的 SHA256 与文件清单：应包含 package.json、MIT LICENSE、lib 的 7 个 JS 模块、src 的 7 个 TS 源文件、tests、scripts、README/CHANGELOG/INSTALL-AGENT 文档和 examples。若含凭据、运行账本或意外代码，停止并报告。解压到新建的独立暂存目录，不在解压目录执行构建脚本。
3. 使用我的 DSH_HOME（如未设置，使用宿主默认值），创建专用 profile。package.json 的 dsh.profile.bundles 使用 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app`。
4. 使用 `dsh plugin --profile research-supervisor add <安装包绝对路径>` 安装，而不是把 tgz 当作 Claude Code 插件，也不要只把 TS 源码复制到某个目录。允许为本次 profile 安装依赖；不修改其他 profile、不使用 `--force` 绕过 peer dependency 不兼容。
5. 创建权限为 0700 的新 projectDirectory，并在该 profile 的 cordis.patch.yml 添加 `research-supervisor` 条目（name 为 `@ddd-research/dsh-research-supervisor`，config.projectDirectory 为上述绝对路径）。已有 patch 要做最小合并，不覆盖宿主模型/账号/sandbox 配置。
6. 继承用户现有模型配置。不要索取、输出或复制明文 API key；如果新 profile 无法使用模型，仅报告缺项。不要通过关闭 compaction/pruning 或改成 danger-full-access 来绕过问题。
7. 执行无模型调用的 `dsh --profile research-supervisor --dump-config`，本机检查插件条目及依赖；不要公开打印整份可能含敏感值的配置。
8. 在不影响已有服务且只监听本机的条件下尝试启动专用 profile。若需要停止服务、处理端口冲突或改变安全设置，先问我。通过 DSH 界面执行 `/research status` 验证命令挂载。如果你的环境无法操作 UI，明确标记“配置检查通过，运行时命令尚未验证”，给出我手动操作的步骤，不得假报验收成功。
9. 不执行 `/research start`，不调用付费模型，不运行论文复现，不重置旧项目 deadline，不删除 writer.lock，不动历史科学结果。
10. 最终给出：安装版本、SHA256、profile/patch/状态目录实际路径、做过的验证、未验项、启动命令、回退方法，以及还缺的模型/科研依赖。request.json 只能生成待填写模板；真实目标、sources、deadline 和费用/算力预算等我批准后再填写并启动。

如果指定版本或服务不可用，给出真实错误并停止在该步骤；不要自动换 provider、用普通聊天模拟本插件或伪造安装成功。
