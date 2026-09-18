# DEV-2 remote-push readiness audit

审计时间：2026-09-18。本文是只读发布准备记录，不表示已经 push、创建 PR、合并或通过 Hosted CI。

## 1. 当前发布边界

| 项目 | 实际值 |
| --- | --- |
| branch | `codex/dev2-tui-preview` |
| HEAD before this report commit | `101936f69aef6b0b1136117e995b0391bc1daf5e` (`docs: refresh developer-facing README`) |
| baseline | `origin/main` = `bc72ee543197510fce8d3943b0251d2fb51d33bb` |
| ancestry before this report commit | `origin/main...HEAD` left/right = `0/17`；当前线性领先 17 commits |
| remote head | `git ls-remote --heads origin codex/dev2-tui-preview` 当前无结果，尚未发布 |
| diff size before this report commit | 76 changed paths，`10,558 additions / 520 deletions`；早期 16-commit 的 `74 / 10,280 / 297` 仅保留为历史 snapshot |
| identity | 17/17 commits 的 author 与 committer 都是 `wszkxlllll <142909575+wszkxlllll@users.noreply.github.com>` |

README 与 `docs/getting-started.md` 已由另一 worker 提交为 `101936f`；本报告尚未提交。预计本报告作为独立 docs commit 后 PR 将保留 18 个 commits；最终 path/count 应在该 commit 后重算，不在报告中自引用自身 hash。

## 2. 将要发布的 feature group

`origin/main..HEAD` 是一条连续的 DEV-2 批次历史，未执行 rebase、squash 或 cherry-pick；当前 snapshot 为 17 commits，本报告提交后预计为 18 commits。提交主题覆盖：

* app-runtime / CLI assembly 与 session lifecycle 抽取；
* CUA 0.22.2 capability doctor、unknown/cleanup 边界和显式 window-target opt-in；
* TUI persistent home/run、correction/abort/feed/text-rendering 和 terminal cleanup；
* Windows fixture、window/adapter/capability probe 及其安全摘要文档；
* 本地真实 WinPTY no-goal UX、真实 run 脱敏诊断和本报告。

这是一个跨 package 的 feature group，而不是只包含单个小修复的 PR。若保持当前历史，建议一个 PR 保留现有 17 个逻辑 commit 加本报告 commit，正文按上述四个层次说明；不建议在发布前重写已审历史。若审阅者要求拆分，应在新 review 计划中明确依赖顺序，而不是临时 cherry-pick 或隐式改变 ancestry。

## 3. 敏感内容与资产检查

对 `origin/main..HEAD` 的 changed paths、当前 HEAD tree 以及当前 17 个 commit 的 diff 做了只读扫描：

* 没有 tracked `.env`、`runs/`、cache、private/secret 目录或 screenshot/media/archive binary；changed paths 也没有 PNG/JPEG/GIF/WebP/BMP/ZIP/7z/RAR/MP4/MOV/PDF 等资产。
* 没有 private-key header、Bearer literal、data-image base64 payload 或绝对用户目录（Windows drive/user path 或 Unix user-home path）匹配。
* 发现的 credential-like 匹配仅是 CLI/provider 的环境变量读取、依赖注入字段和测试 fixture 名称；扫描没有发现 literal credential value。合法的 GitHub author email 不属于敏感命中。
* 文档中的 `.env`、`runs/` 和 `<envfile>` 只用于说明“不读取/不提交”或本地 ignored 证据边界；真实 transcript、PNG、daemon/fixture binary 不在 commit 中。
* `101936f` 只包含 README 与 Getting Started；该 docs commit 的 `git diff --check` exit `0`，路径无敏感资产，内容无私钥/Bearer/data-image/绝对用户目录；credential-like 扫描只命中环境变量名称，没有 literal value。
* README 与 `docs/getting-started.md` 做了本地相对链接检查：10 个 repository-relative targets 均存在；GitHub/OSWorld 外部链接只做了语法保留，未在本次离线审计中声称远端可达。

这项检查不读取 `.env`，也不从 ignored 运行资产恢复或打印秘密。README/Getting Started 写入工作树后再次扫描仍未发现敏感类别；最终 docs commit 形成后，仍应对最终 `git diff origin/main..HEAD --check`、文件名和 staged set 重做一次同类扫描。

## 4. 已有验证证据（作者记录与本次独立检查分开）

本次独立执行了 branch/ancestry/identity/remote-head 与上述敏感扫描。此前本 worker 在固定候选 dist 上独立执行的终端验证已提交在 `0b040989`：Node 24.19.0、真实 pywinpty、rapid/slow × ESC-Q/Ctrl-C 四场景全部 exit 0，中文/500-limit/tail/resize/footer/cursor restore 通过，无模型/API/CUA/桌面动作。完整数据与限制见 `docs/dev-2-tui-ux-pty-validation-results.md`。

窗口/doctor、app-runtime 和早期 focused/full 测试的其他数字来自各自实施者或协调者报告；不把它们改写成本次 push-readiness audit 亲自重新执行的结果。在 README 内容已写入工作树、但尚未形成 `101936f` commit 时，本次唯一集成执行者实际运行了：

```powershell
pnpm run typecheck
pnpm test
pnpm --filter @computer-harness/cli start -- --help
git diff --exit-code -- pnpm-lock.yaml
git diff --check origin/main..HEAD
```

实际结果（Node `v24.19.0`、pnpm `11.19.0`）：`pnpm run typecheck` exit `0`；`pnpm test` exit `0`，32 test files / 320 tests passed；CLI `--help` exit `0`；`git diff --exit-code -- pnpm-lock.yaml` exit `0`；tracked worktree `git diff --check` exit `0`；`pnpm install --frozen-lockfile --ignore-scripts --offline` exit `0`，lockfile up to date。随后到当前 HEAD 之间只新增了 `101936f` 的 README/Getting Started 文档提交，没有业务代码或 lockfile 改动，因此本次不重复构建/测试。全程未加载 provider credentials，未启动模型/CUA/桌面。上述是本地集成事实，不是 Hosted CI、三平台矩阵、artifact 或 GitHub checks 通过证明。

补充的最终范围检查：`git diff --check 101936f^..101936f` 与本报告自身 commit 的 diff-check 均为 `0`；但完整 `git diff --check origin/main..HEAD` 当前 exit `2`，报告 7 个历史 Markdown trailing-whitespace 行，全部集中在 `docs/dev-2-cua-capability-and-extension-research.md`（4 行）和 `docs/dev-2-cua-target-integration-assessment.md`（3 行）的 Markdown 硬换行。它们不是本次 README、Getting Started 或 readiness 文档新增内容；本报告不改写其他 worker 的 owner 文档，发布前应由 owner 决定保留 Markdown hard-break 或单独修正。

## 5. 已知限制与发布前门槛

1. 本报告仍未提交，远端 branch 尚不存在；本报告 commit 后需重新确认 `git status`、HEAD、18-commit count 和 staged 文件范围。
2. 这 17 commits + 本报告 / 76 paths 的 review surface 较大；一个 PR 最能保留当前依赖和提交证据，但需要在正文明确 DEV-2 范围及未完成的通用 focus/AX、跨平台、完整 model Run、真实用户桌面和产品化 target 能力。
3. CUA doctor 的真实 Windows 结果保留 `unknown`/`desktop_capture_scope_unconfirmed` 等保守状态；不能写成 live desktop green。window adapter 只放行显式 host target 的窄 click 链路，键盘、通用焦点和其他 pointer primitive 不应在 PR 中暗示已放行。
4. no-goal WinPTY 证据不是完整 model Run 证据；T10 synthetic fixture 与此前用户失败 run 诊断也应保持边界，不能把 `CUA_TOOL_REFUSED` 或 provider transport cancellation 猜成单一根因。
5. ignored raw screenshots/transcripts 可供本地复核但不属于可分享发布 artifact；文档只保留脱敏统计和可复现入口。

## 6. 推荐的后续发布顺序

1. 先提交本报告这一独立 docs commit；不覆盖或重写已审 README/Getting Started。
2. 本报告 commit 完成后重做一次 identity、`origin/main..HEAD`、敏感文件/内容、`git diff --check` 和 lockfile 漂移检查，并记录最终 18-commit/path count；不要把初始 16/74 snapshot 当最终计数。
3. 若最终 docs 只改变文档且业务树未漂移，可复用本节 Node 24 离线集成结果；否则按同一命令重跑并记录实际退出码、test count、help 和 lock 结果。完整 range diff-check 的 7 个历史 Markdown trailing-whitespace 行需在 PR 正文标注或由 owner 另行决定修正。
4. 由发布 owner 仅 push `codex/dev2-tui-preview` 并创建一个 base `main` PR；不 push `main`、不 merge、不修改 branch protection。PR 创建后再以 GitHub API 核验每个 commit 的 author/committer 和实际 checks，不能预写“CI passed”。

本报告自身只覆盖发布准备审计；没有执行远端写入、PR、merge、模型请求或桌面动作。

## 7. 可复用 PR 草稿（尚未创建）

建议标题：`feat(dev2): add controlled TUI and CUA window preview`

正文要点：

* 保留当前线性 18-commit DEV-2 feature group（17 个已有 commit 加本报告 docs commit），覆盖 app-runtime/session assembly、persistent TUI/correction/feed/text rendering、CUA doctor 与显式 window-target preview，以及对应 focused probes/docs。
* 本地 Node `v24.19.0` / pnpm `11.19.0` 验证：typecheck 通过；全量 32 files / 320 tests 通过；CLI help、frozen-lockfile offline install、lock drift 通过；README/Getting Started/readiness 自身 diff-check 通过。base-to-head 全范围仍有 7 个历史 Markdown hard-break trailing-whitespace 行，未在本批隐式改写。
* 独立 Windows WinPTY no-goal rapid/slow × ESC-Q/Ctrl-C 四场景通过；证据只覆盖 terminal UX，不等同完整 model Run、通用 focus/AX、跨平台或真实用户桌面。
* CUA doctor 和 window adapter 保持 `unknown`/scope/focus/cleanup 的 fail-closed 边界；window keyboard、通用 focus、其他 pointer primitive、完整 live desktop 仍未放行。
* 不包含真实凭证、私密截图、runs/transcripts、VM/桌面资产；Hosted CI 与 GitHub checks 在 PR 创建后再以实际结果报告，不预写通过。
