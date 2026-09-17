# DEV-0 CI 实施结果

日期：2026-09-17
文档角色：结果
状态：当前执行
当前入口：[Stage 6 当前实施入口](./stage-6-convergence-and-start-state-2026-09-15.md)
基线：`39ff27f9a4ef5431450df6991793403ec890f993`；Node.js `24.19.0`；pnpm `11.19.0`
范围：新增普通 PR、`main` push 和手动触发的 GitHub-hosted 离线 CI；不覆盖真实 Provider、桌面、发布、分支保护或远端设置

## 1. 结论

DEV-0 的 CI 工作流已经写入 [.github/workflows/ci.yml](../.github/workflows/ci.yml)，等待一次真实 PR 或 `workflow_dispatch` Hosted 运行验证。工作流只使用当前仓库已有脚本和锁文件，不传模型密钥、不连接真实桌面、不上传 `runs/`、截图、`.env` 或 Provider 原始交换。

`verify` 是四项 Hosted 矩阵：Ubuntu 24.04 x64、Windows Server 2025 x64、macOS 15 arm64 使用同一 Node `22.13.0` 基线；Ubuntu 24.04 x64 另用 Node `24.19.0` 做兼容性检查。`required` 的稳定检查名为 `ci-required`，通过 `needs.verify.result` 只接受完整矩阵的 `success`，失败、取消和跳过均返回失败。没有设置分支保护，因此该检查目前尚未成为远端合并规则。

## 2. 实施内容

### 2.1 触发、权限和并发

- `pull_request`：所有普通 PR 运行；不使用 `pull_request_target`。
- `push`：只运行 `main`。
- `workflow_dispatch`：允许维护者手动重跑。
- 顶层权限只有 `contents: read`；checkout 关闭持久化凭据。
- 同一 PR 或 ref 的旧离线运行可取消；没有 self-hosted runner、模型 secret、桌面权限或 VM 步骤。

### 2.2 矩阵和工具链

| 角色 | Hosted 标签 | 期望架构 | Node | 用途 |
|---|---|---:|---:|---|
| baseline | `ubuntu-24.04` | x64 | `22.13.0` | Linux 必跑基线 |
| baseline | `windows-2025` | x64 | `22.13.0` | Windows 必跑基线 |
| baseline | `macos-15` | arm64 | `22.13.0` | macOS 必跑基线 |
| compatibility | `ubuntu-24.04` | x64 | `24.19.0` | Linux 另一档受支持 Node |

镜像标签、Node 补丁版本和架构写入矩阵；运行时还打印 `RUNNER_OS`、`RUNNER_ARCH`、`process.version`、`process.arch` 和受测提交 SHA，并在架构不符时失败。Node 由固定 SHA 的 `actions/setup-node` 安装；pnpm 由固定 SHA 的 `pnpm/action-setup` 从根 `packageManager` 读取，并开启其锁文件缓存。工作流另有跨平台检查，要求实际 pnpm 版本等于根 `package.json` 的 `packageManager` 版本 `11.19.0`。

本次只读核验了官方 Git 标签（命令为 `git ls-remote`，未写远端）：

| Action | 固定提交 | 核验结果 |
|---|---|---|
| `actions/checkout` v6 | `d23441a48e516b6c34aea4fa41551a30e30af803` | `refs/tags/v6` 直接指向该提交 |
| `actions/setup-node` v6 | `249970729cb0ef3589644e2896645e5dc5ba9c38` | `refs/tags/v6` 直接指向该提交 |
| `pnpm/action-setup` v4 | `b906affcce14559ad1aafd4ab0e942779e9f58b1` | `refs/tags/v4^{}` 解引用到该提交；标签对象为 `f40ffcd9367d9f12939873eb1018b921a783ffaa` |
| `actions/upload-artifact` v4 | `ea165f8d65b6e75b540449e92b4886f43607fa02` | `refs/tags/v4` 直接指向该提交 |

### 2.3 检查顺序和报告边界

每个矩阵项按以下顺序执行：

1. checkout 受测提交。
2. `pnpm install --frozen-lockfile`。
3. `pnpm run typecheck`。当前根 `build` 只是委托到 `typecheck`，而 `typecheck` 的 `tsc -b` 会生成项目引用和 CLI `dist`，因此只执行一次，避免重复构建。
4. 用真实存在的 Vitest 配置执行单元/合同测试，并只写 `.ci-reports/vitest.xml`。
5. 执行 `node apps/cli/dist/index.js --help`，不触发 Provider 或桌面。
6. 执行 `git diff --exit-code -- package.json pnpm-lock.yaml pnpm-workspace.yaml`，发现依赖文件漂移即失败。
7. 无论测试成功或失败，只上传 `.ci-reports/vitest.xml`，保留期 7 天；不把该上传步骤的 `always` 当作忽略前序失败。

没有 `continue-on-error`、跳包、重写断言或 `if: false`。矩阵使用 `fail-fast: false`，便于同一次运行看到各平台结果；macOS 是 required 矩阵项，不可忽略。

## 3. 本次实际验证

以下命令均在仓库根目录执行，执行 shell 只前置了用户指定的 Node 路径，没有修改系统 PATH。本节表格保留第一轮返工后的早期实测；其中 `190` 项已被后续 Risk 返工和第 7、8 节的复核覆盖，最新计数见第 8 节。所有结果仍只是本地集成证据，不是 Hosted 结果。

| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 通过；`Scope: all 14 workspace projects`，`Already up to date` | pnpm `11.19.0` 输出 |
| `pnpm run typecheck` | 通过，退出码 0（早期记录） | 第一轮返工后的当时工作树中，`tsc -b` 与 spike `--noEmit` 均通过；已被第 8 节覆盖 |
| `node apps/cli/dist/index.js --help` | 通过 | 输出 `Usage: computer-harness ...` |
| `git diff --exit-code -- package.json pnpm-lock.yaml pnpm-workspace.yaml` | 通过，退出码 0 | 安装未改写依赖文件 |
| 官方 Action 标签只读核验 | 通过 | 上表的 `git ls-remote` 结果 |
| 工作流 YAML 结构解析 | 通过 | PyYAML 可解析为 2 个 job、4 个矩阵项；尚未运行 actionlint |
| 全量 `pnpm test` | 通过，退出码 0（早期记录） | Vitest `15` 个文件、`190` 项测试全部通过；当时包含 Risk 回归测试，不包含真实 Provider/桌面；已被第 8 节覆盖 |

类型检查会产生被 `.gitignore` 忽略的 `dist/` / `*.tsbuildinfo`，不改变受跟踪依赖文件。当前工作树原有的大量文档修改、归档和删除属于用户工作；Risk worker 的业务/回归测试修改也属于并行实施范围，本 worker 未清理、覆盖或回滚。

## 4. Hosted 与本地结果的区别

实施阶段最初没有提交、push 或调用 GitHub Actions；随后用户授权建立本地检查点、push 工作分支并创建 PR #1。以下 B 项按该 PR 的真实 Hosted run 更新，仍需区分 Hosted 证据与本地验证：

- B01：通过。PR [#1](https://github.com/wszkxlllll/Computer-Harness/pull/1) 的 [Hosted run 35206262326](https://github.com/wszkxlllll/Computer-Harness/actions/runs/35206262326) 以 head `d57d9a8c7864c521b5ccfbb9ece7e45f2611e0c1` 触发；Ubuntu 24.04/Node 22.13.0、Windows 2025/Node 22.13.0、macOS 15/Node 22.13.0、Ubuntu 24.04/Node 24.19.0 四个 verify 与 `ci-required` 均成功，每个矩阵实际通过 15 个文件、200 项测试。
- B02：未做故意失败合同测试；`ci-required` 的 fail-closed 逻辑随本次真实成功 run 执行，但尚无注入失败后的独立失败记录。
- B03：通过 artifact 范围检查，但不等于完成完整注入验收。Sol 独立核验四个 artifact 均只含对应的 `vitest.xml`，未发现敏感数据；本次没有向私有 `runs/` 写入 synthetic marker，因此“合成敏感标记注入”仍未执行。
- B05：通过。Linux Node `24.19.0` 兼容性矩阵成功。
- B06：仅证明所测 macOS Hosted 镜像上的代码/构建兼容；真实 Mac 的截图、辅助功能权限、焦点、点击和键盘输入仍未验证，也不推及其他架构。

本地验证不能替代 Hosted runner 证据，也不能证明真实 Mac 的截图、辅助功能授权、焦点、点击或键盘输入。上述 macOS CI 成功仍只说明所测 Hosted 镜像上的代码与构建兼容；真实桌面必须另行授权验收，不能推及 Intel 或其他 Apple Silicon 架构。

## 5. 风险、回滚与下一步

- 首次 Hosted run 已完成并通过；后续 workflow 修改仍需新 run 验证 optional native package 的平台差异，不能通过跳过测试放行。
- runner image 的补丁内容仍由 GitHub Hosted 管理；工作流固定标签和架构并打印实际运行信息，首次运行应把日志中的镜像版本补入阶段结果。
- `ci-required` 已建立但尚未配置为分支保护必需检查；是否设置规则须由仓库所有者另行授权和核实套餐能力。
- 回滚只需删除 `.github/workflows/ci.yml` 以及本结果文档，不涉及业务源码、依赖或远端状态。
- 后续修改按同一工作流在真实 PR 或手动运行中重跑；本文件的 Hosted 结论只对应 PR #1 的 head，不把模板或静态解析替代新提交的 CI 结果。

## 6. 操作边界

CI 实施阶段只修改 `.github/workflows/ci.yml` 和本结果文档；未修改业务代码、package 脚本或锁文件。随后仅按用户授权建立本地 checkpoint、push 工作分支并创建 PR；未 merge、未设置分支保护，未消费模型 API 额度，未操作真实桌面、VM、截图或私密 runs。

## 7. Risk 第一轮返工后的中间复核（已过时）

2026-09-17，在 Risk worker 第一轮返工并将回归测试移入 `packages/risk-guard` 后，本 worker 对当时工作树执行集成复核。第 3 节记录的 `15` 个文件、`190` 项测试是更早的返工前证据；本节的 `194` 项曾是当时结果，但已被第 8 节再次返工后的当前复核覆盖，不再作为最新计数。

| 命令 | 当时结果（已过时） | 证据 |
|---|---|---|
| `pnpm run typecheck` | 通过，退出码 0（早期记录） | `tsc -b` 与 spike `--noEmit` 均覆盖当时返工后的源文件；已被第 8 节覆盖 |
| `pnpm test` | 通过，退出码 0（早期记录） | Vitest `15` 个文件、`194` 项测试全部通过；含当时的 Risk 回归测试，已被第 8 节覆盖 |
| `node apps/cli/dist/index.js --help` | 通过，退出码 0（早期记录） | 输出 `Usage: computer-harness ...`；已被第 8 节覆盖 |
| `git diff --exit-code -- package.json pnpm-lock.yaml pnpm-workspace.yaml` | 通过，退出码 0（早期记录） | 当时复核后依赖文件未漂移；已被第 8 节覆盖 |

以上是当时的本地 Node/pnpm 集成执行，不是 GitHub-hosted 运行；B01/B02/B03/B05/B06 的 Hosted 证据状态仍按第 4 节保持未验证。

## 8. Risk 再次返工后的中间复核（已过时）

2026-09-17，在 Risk worker 再次返工完成后，本 worker 对当时工作树执行了一轮集成复核。当前工作树使用 Node `24.19.0` / pnpm `11.19.0`；本节的 `198` 项曾覆盖第 7 节的中间 `194` 项计数，但已因后续 Risk 修复被第 9 节末次复核覆盖，不再作为最新证据。

| 命令 | 当时结果（已过时） | 证据 |
|---|---|---|
| `pnpm run typecheck` | 通过，退出码 0（早期记录） | `tsc -b` 与 spike `--noEmit` 均覆盖当时 Risk 源文件；已由第 9 节覆盖 |
| `pnpm test` | 通过，退出码 0（早期记录） | Vitest `15` 个文件、`198` 项测试全部通过；`packages/risk-guard/src/index.test.ts` 为 20 项，`packages/risk-guard/src/runtime-regression.test.ts` 为 4 项；已由第 9 节覆盖 |
| `node apps/cli/dist/index.js --help` | 通过，退出码 0（早期记录） | 输出 `Usage: computer-harness ...`；已由第 9 节覆盖 |
| `git diff --exit-code -- package.json pnpm-lock.yaml pnpm-workspace.yaml` | 通过，退出码 0（早期记录） | 当时复核后依赖文件未漂移；已由第 9 节覆盖 |

本节仍是本地集成证据，不是 GitHub-hosted 运行；Hosted 矩阵及 B01/B02/B03/B05/B06 的状态不因本地 `198` 项通过而改变。

## 9. Luna 最终修复后的末次当前工作树复核

2026-09-17，在 Luna 删除整个引用 helper、Risk worker 最终修复完成后，本 worker 按要求仅执行一次末次集成复核。当前工作树使用 Node `24.19.0` / pnpm `11.19.0`；本节是文档中最新的本地计数，覆盖第 8 节的中间 `198` 项，不采用手工相加的测试数字。

| 命令 | 末次当前结果 | 证据 |
|---|---|---|
| `pnpm run typecheck` | 通过，退出码 0 | `tsc -b` 与 spike `--noEmit` 均覆盖最终 Risk 源文件 |
| `pnpm test` | 通过，退出码 0 | Vitest 实际摘要为 `15` 个文件、`200` 项测试全部通过；`packages/risk-guard/src/index.test.ts` 为 22 项，`packages/risk-guard/src/runtime-regression.test.ts` 为 4 项 |
| `node apps/cli/dist/index.js --help` | 通过，退出码 0 | 输出 `Usage: computer-harness ...` |
| `git diff --exit-code -- package.json pnpm-lock.yaml pnpm-workspace.yaml` | 通过，退出码 0 | 末次复核后依赖文件仍未漂移 |

第 9 节仍是本地 Node/pnpm 集成证据；真实 Hosted 状态见第 10 节，不能用本地 `200` 项通过替代其他 head 的 Hosted 结果。

## 10. PR #1 的真实 Hosted 验证

PR [#1](https://github.com/wszkxlllll/Computer-Harness/pull/1) 的 head 为 `d57d9a8c7864c521b5ccfbb9ece7e45f2611e0c1`，base `main` 为 `39ff27f9a4ef5431450df6991793403ec890f993`。其 [pull_request run 35206262326](https://github.com/wszkxlllll/Computer-Harness/actions/runs/35206262326) 已完成，事件为 `pull_request`，结论为 `success`：

| Hosted job | 结果 | 实际链接 |
|---|---|---|
| `verify (ubuntu-24.04, Node 22.13.0)` | success；15 files / 200 tests | [job 105152693220](https://github.com/wszkxlllll/Computer-Harness/actions/runs/35206262326/job/105152693220) |
| `verify (windows-2025, Node 22.13.0)` | success；15 files / 200 tests | [job 105152693341](https://github.com/wszkxlllll/Computer-Harness/actions/runs/35206262326/job/105152693341) |
| `verify (macos-15, Node 22.13.0)` | success；15 files / 200 tests | [job 105152693091](https://github.com/wszkxlllll/Computer-Harness/actions/runs/35206262326/job/105152693091) |
| `verify (ubuntu-24.04, Node 24.19.0)` | success；15 files / 200 tests | [job 105152693408](https://github.com/wszkxlllll/Computer-Harness/actions/runs/35206262326/job/105152693408) |
| `ci-required` | success | [job 105153001728](https://github.com/wszkxlllll/Computer-Harness/actions/runs/35206262326/job/105153001728) |

Sol 独立检查 run artifacts：四个 artifact 分别为 `vitest-macos-15-node-22.13.0`、`vitest-ubuntu-24.04-node-22.13.0`、`vitest-ubuntu-24.04-node-24.19.0`、`vitest-windows-2025-node-22.13.0`，各自只含 `vitest.xml`，未发现敏感数据。该检查不等于 B02 的失败注入，也不等于真实桌面验收。
