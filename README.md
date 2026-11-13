# DSH Research Supervisor — 0.2.0-rc.1

用于 **DeepSeek Harness（DSH）** 的原生研究监管插件。不是 Claude Code 插件，不能直接装入 Claude Code 的插件面板。安装工作可以委托给 Claude Code 等有终端权限的 Agent。

Planner → 独立计划审核 → Executor → 独立结果审核，围绕 Claim → Evidence → Task DAG 运行。返工复用生产者会话，跨任务可继承生产者上下文；Reviewer 始终使用新会话，不继承生产者 transcript。交付被封存和哈希，科学质量仍由 Reviewer 检查真实计算与数据，不能靠 JSON 校验替代。

**MIT 开源，预发布版本。** 源码仓库：[ussumer/research-supervisor](https://github.com/ussumer/research-supervisor)。许可见 [LICENSE](LICENSE)，允许使用、修改和再分发，并须保留版权及许可声明。安装包包含 `src/`、`tests/`、`scripts/` 与编译后的 `lib/`；尚未发布 npm registry。

## 兼容性与准备

- `pnpm` 必须在 PATH 中可用，`dsh plugin` 会调用它安装依赖。
- Node.js **>=24.9**，宿主 **`@deepseek-ai/dsh@0.2.1-rc.5`**；本包的 DSH peer dependencies 锁定该版本。不要直接换成其他 RC 或 latest。
- 已验证环境：Linux/WSL。文件封存不再依赖 `/proc/self/fd`，但 native Windows PowerShell/macOS 的完整角色工具链未验收。
- 使用 DSH 原生 base + web profile，需具备 commands、agents、tools、workingDirectory、agentLoop，以及 native shell/sandbox/sandboxPolicy（`workspace-write`）。完整上下文需要 sessionQuery；标准 base 自带 sqlite 实现。
- 模型由启动研究的父会话继承；包内没有 endpoint、API key 或模型账号。用户自行在宿主配置，并确认模型费用与算力预算。
- 科研软件、Python/数值库、论文与输入数据另行准备。插件不自动安装科学依赖，也不保证论文复现成功。

检查现有宿主：

```bash
node --version
```

```bash
dsh --version
```

没有 DSH 时，可在确认允许安装后安装这个**指定版本**；已有不同版本时，优先使用独立安装目录，不要覆盖正在使用的全局宿主：

```bash
npm install --global @deepseek-ai/dsh@0.2.1-rc.5
```

## 安装：独立 profile + 本地 tarball

获得 `ddd-research-dsh-research-supervisor-0.2.0-rc.1.tgz`、`SHA256SUMS`、本 README 和 `INSTALL-AGENT.md`。在交付目录核对：

```bash
sha256sum -c SHA256SUMS
```

SHA256 仅检查传输完整性，不能替代对分发来源的信任。不要使用 `src.zip`，它不是安装包。

1. 在 `${DSH_HOME:-$HOME/.dsh}/profiles/research-supervisor` **新建** profile。若已存在，先备份、检查现有内容，不要覆盖。其 `package.json` 使用以下内容（也见 `examples/profile.package.json`）：

```json
{
  "name": "dsh-research-profile",
  "private": true,
  "type": "module",
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
```

2. 用 DSH 的 profile 包管理命令安装 tarball；将路径换成下载包的绝对路径。这会委托 pnpm 安装并可能联网下载 peer dependencies，不能保证完全离线：

```bash
dsh plugin --profile research-supervisor add /absolute/path/ddd-research-dsh-research-supervisor-0.2.0-rc.1.tgz
```

3. 创建一个新的项目状态目录，例如 `/absolute/path/research-state/project-001`，权限设为 `0700`。它必须在所有 `sources` 之外，二者不能互为祖先目录。profile 的 `cordis.patch.yml` 写入：

```yaml
- insert:
    - id: research-supervisor
      name: '@ddd-research/dsh-research-supervisor'
      config:
        projectDirectory: /absolute/path/research-state/project-001
```

也可以使用 `examples/cordis.patch.yml` 中的 `DSH_RESEARCH_PROJECT_DIRECTORY` 环境变量形式，但必须在每次启动宿主时设置该变量。

4. **不调用模型的配置检查**：

```bash
dsh --profile research-supervisor --dump-config
```

本机检查输出含 `research-supervisor` 条目和正确的绝对状态目录；不要把整份宿主配置贴给他人，可能包含模型连接信息。配置组合成功不等于插件已挂载。

5. 在本地可信环境启动独立 profile（不要把 UI 或 API 暴露到公网）：

```bash
dsh --profile research-supervisor
```

在该 DSH 界面输入 `/research status`，应看到 `No project is active in this plugin instance.`。这是加载检查，不会启动研究模型。不要为验安装执行 `/research start`。

## 使用：安装与启动研究是两次授权

准备 `request.json`（模板见 `examples/request.json`）：

```json
{
  "goal": "复现指定论文的明确子问题；写清物理参数、网格/时间步、参考量、容差、禁止降级项以及算力限制",
  "sources": ["/absolute/path/to/paper-and-inputs"],
  "deadline": "替换为用户批准的未来 ISO 8601 截止时间",
  "maxReplans": 2,
  "producerContext": "full"
}
```

`producerContext` 可选：`full` 共享生产者原生历史，`isolated` 为默认模式。压缩、历史缺失或超窗时允许显式 file/README handoff，checkpoint 会记录 `contextLoss`；不再声称完整历史。宿主重启后使用磁盘文件交接，不恢复已经丢失的内存 Agent。

在**DSH 界面**中运行（不是 bash 命令）：

```text
/research start /absolute/path/request.json
/research status
/research pause
/research resume
/research reconcile
```

- `start` 会真正调用模型、执行科研工具，必须先获用户授权。已有项目时 attach 原状态，不用新 request 覆盖原目标或 deadline。
- `resume` 可重新 attach 已暂停的磁盘项目；不会重置 deadline、maxAttempts、maxReplans。
- `reconcile` 用于明确解除 blocked 状态，再 `resume`；运行中需先 pause。它不会伪造批准、修改历史审核、增加尝试次数或补齐缺失证据；预算已耗尽仍可能 blocked。
- stale writer lock 自动恢复；活进程持有的 lock 不会强制删除。不要手工删除未知活跃实例的锁。
- Planner 可为 Task 指定 `timeoutMinutes`。每次角色运行使用 `min(项目截止, 当前时间 + task timeout)`。未指定则使用项目截止。
- 一个插件实例对应一个状态目录和绑定父会话；新研究使用新的 profile/状态目录，不覆盖旧账本。

## 安全和证据边界

适用可信内部工程环境，不提供多租户安全保证。原生文件写入 sandbox 不是网络/读取/凭据隔离，`/tmp` 可能可写；已取消 hardlink 特殊检查。不得把凭据目录或宿主根目录当 sources。科学任务的 CPU、内存、进程、网络和费用限制须由宿主/容器及运行策略另行落实。

会话 transcript 可能包含工具输出；按宿主的数据与日志策略管理。插件不打包历史科研产物、真实模型日志或凭据。哈希及只读快照证明完整性，不证明科学正确性。

## 升级与回退

先 `/research pause`，停止当前专用 profile，备份整个项目状态目录；然后在该 profile 安装新 tarball、检查配置并重新启动。不要在已有写者运行时替换包。

回退时在停止宿主后安装旧 tarball，并使用对应升级前状态备份；不要假定老版本能读懂新状态。`0.2.0-rc.1` 尚无跨版本状态迁移保证。停止/卸载插件不会自动删除论文、工作目录、快照或账本。

## 构建、测试与打包（开发者）

源码目录需能解析上述兼容的 DSH 依赖。测试另使用 DSH base、session-query-sqlite 等宿主组件；本仓库验证环境使用指定版本的完整宿主依赖树。面向使用者的 tarball 已含编译好的 `lib`，安装不需要 TypeScript 编译。

```bash
npm test
```

```bash
mkdir -p dist
```

```bash
npm pack --pack-destination dist
```

`prepack` 会运行测试（含构建），不是直接分发旧 lib。构建仅执行 TS 类型擦除和 JS 语法检查，**不是完整 tsc 类型检查**。`files` 白名单包含 7 个编译 JS 模块、对应 `src/` 源码、工程 `tests/`、构建/打包脚本、文档与 examples，不含 node_modules、src.zip 或研究数据。

本版本发布前工程回归 **221/221 通过**；使用本地 scripted provider 驱动真实 DSH kernel/工具，不调用付费模型。这不等同于外部模型科学验收，也不代表所有操作系统均通过。

需要让 Agent 安装时，把安装包、校验文件和 [INSTALL-AGENT.md](INSTALL-AGENT.md) 一起交给它。
