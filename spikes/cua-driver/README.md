# CUA Driver technical probe

This directory is an isolated stage-0 probe. It is not the product Computer adapter.

The probe will only become executable after the package API is inspected and a minimal
`observe → action → observe` path is confirmed. It must not be imported by the core
protocol or Runtime packages.

The probe must record driver version, operating system, DPI, viewport, capture size,
coordinate space, session lifecycle, and any stale-frame or reconnect error. Screen
captures stay under the ignored local `runs/` directory and must not be committed.

## Commands

From the repository root:

```text
pnpm probe:cua
```

This performs one named-session screen-size query and one desktop capture. It does
not click or type. The output directory defaults to `spikes/cua-driver/runs/<timestamp>`.

Input actions are opt-in and require an explicit flag:

```text
pnpm --filter @computer-harness/cua-driver-spike probe -- --allow-input --click-x 300 --click-y 200
pnpm --filter @computer-harness/cua-driver-spike probe -- --allow-input --type "probe text"
```

Only run the input form when the desktop is prepared for the test. The probe writes
JSON metadata and PNG captures locally; inspect the result before changing the
Computer adapter.

## Stage 3 capability probe (read-only)

This probe records the CUA SDK/daemon contract without taking a screenshot or sending desktop
input. It calls typed `metadata`, `listToolsJson`, session inspection, and the generic
`callTool` path, then writes a JSON-safe report under the ignored output directory:

```text
pnpm --filter @computer-harness/cua-driver-spike probe:capabilities -- --session stage3-capabilities
```

To inspect an already running daemon instead of the embedded SDK, provide its private socket:

```text
pnpm --filter @computer-harness/cua-driver-spike probe:capabilities -- \
  --socket <private-socket> --session stage3-capabilities
```

The report includes driver metadata, tool-inventory shape/count, typed versus generic session
views, host-level session summaries, health/permission results, execution mode, availability,
and per-operation errors. Prefer an absolute `--output` path when invoking through pnpm so the
result is not made relative to the selected package's working directory. A successful read-only
probe is not evidence that input actions or frame freshness work; those are separate gates.

## Stage 3 action and lifecycle probe

`probe:actions:daemon` is the disposable S3-1B probe. It always requires an explicit binary and
private daemon socket, so it cannot silently fall back to the embedded SDK. It compiles a small
isolated WinForms fixture, exercises the G1-G4 matrix, and removes only the fixture it launched.
Screenshots and raw JSON remain under ignored `runs/` output and must not be committed:

```text
pnpm --dir spikes/cua-driver run probe:actions:daemon -- `
  --binary <path-to-cua-driver.exe> `
  --socket '\\.\pipe\computer-harness-actions-r1' `
  --output 'runs/stage3-actions-daemon-r1' `
  --session 'stage3-actions-r1'
```

This probe is evidence for the Windows daemon boundary only. Its `accepted_by_driver` result does
not prove semantic task completion; an action-after-observation or verifier is still required.

## S3-4 adapter contract probe

`probe:adapter` is the first real-daemon check of the thin
`@computer-harness/computer-cua` package. It launches only the supplied isolated fixture,
opens the adapter, observes, brings that fixture to the foreground immediately before the
foreground click, types a fixed test string, observes again, closes the session, and removes
the exact fixture PID. It does not use Notepad, user files, or an embedded CUA fallback:

```text
pnpm --dir spikes/cua-driver run probe:adapter -- `
  --binary <path-to-cua-driver.exe> `
  --socket '\\.\pipe\computer-harness-adapter-r1' `
  --fixture <path-to-isolated-computer-harness-fixture.exe> `
  --output 'runs/stage3-adapter-contract-r1'
```

The explicit foreground preparation belongs to the disposable test harness. The production
adapter only sends the public desktop action; it does not guess or silently steal a target
window. The redacted `summary.json` records viewport, action receipts, and fixture text length;
screenshots and raw driver data remain local under ignored `runs/`.

## Side-by-side production window retest

These are optional diagnostic probes, not prerequisites for normal TUI use.
The Harness does not arrange user windows; only these owned-fixture experiments
set window geometry. The 2026-09-20 user requested that further experiments stop.
Existing failed/partial artifacts remain evidence, not passing acceptance results.

| Script alias | File | Purpose |
|---|---|---|
| `probe:adapter:side-by-side` | `dev2-adapter-window-side-by-side-retest.ts` | Production adapter and scripted approval against owned native windows |
| `probe:window:matrix` | `dev2-window-action-matrix-retest.ts` | Separate covered/uncovered and foreground/background input cases |
| `probe:browser:window` | `browser-adapter-probe.ts` | Isolated browser profile and local fixture; requires explicit `--allow-input` |

All three can create real windows and dispatch input. Run only with explicit
permission, a private socket/output directory, and no concurrent desktop driver.
See the [current evidence and limitations](../../docs/travel-pilot-preparation-2026-09-20.md#117-用户决定停止追加实验当前交付状态).

`probe:adapter:side-by-side` launches two owned WinForms fixtures side by side
(left witness/control, right target) and drives only the exact target PID/window
through the production `CuaDriverComputer` with explicit foreground delivery.
It records a target observe before/after focusing the left witness, screenshot
hashes, click/type/scroll/Ctrl+A+replace/drag receipts, both fixture oracles,
and one local scripted-provider approval click. The witness is never placed over
the target; this probe does not claim covered-window isolation or focus restore.
The foreground scroll path is now enabled in the production adapter; rebuild
before a future probe so it does not load an older `dist` gate:

```text
pnpm --dir spikes/cua-driver run probe:adapter:side-by-side -- `
  --binary <path-to-cua-driver.exe> `
  --socket '\\.\pipe\computer-harness-side-by-side-r1' `
  --fixture <path-to-isolated-computer-harness-fixture.exe> `
  --output 'runs/dev2-adapter-window-side-by-side-r1'
```

The command uses no model/API credentials and leaves all captures and trajectory
artifacts under the ignored output directory.

## S3-4 Runtime/Trajectory contract probe

`probe:runtime` runs two separate daemon lifecycles with the real
`CuaDriverComputer`, `RunController`, `JsonlRunEventWriter`, and `FileAssetStore`:

```text
pnpm --dir spikes/cua-driver run probe:runtime -- `
  --binary <path-to-cua-driver.exe> `
  --socket '\\.\pipe\computer-harness-runtime-r1' `
  --fixture <path-to-isolated-computer-harness-fixture.exe> `
  --output 'runs/stage3-runtime-contract-r1' `
  --rounds 20
```

The first lifecycle performs 20 current-observation-bound clicks and verifies event ordering,
reducer reconstruction, unique observations, screenshot assets, and fixture progress. The second
stops the private daemon immediately before an action and verifies `outcome_unknown`, no terminal
action receipt, and no replay. Both summaries are redacted; screenshots, fixture text, and raw
driver logs stay in ignored local output.

## Independent daemon comparison

The embedded SDK runs inside `node.exe` and inherits its DPI context. To compare it
with the process-isolated CUA path, obtain an official `cua-driver.exe` binary
outside Git and run:

```text
pnpm probe:cua:daemon -- \
  --binary <path-to-cua-driver.exe> \
  --socket \\\.\pipe\computer-harness-stage0 \
  --session stage0-daemon
```

The probe starts `cua-driver serve` as a private child process, connects with
`CuaDriver.connect(socketPath)`, captures one desktop frame, then stops the child.
It does not register autostart, execute input, or change global configuration. The
output is written under `spikes/cua-driver/runs/` and is ignored by Git.

## Stage 4 static API conformance probe

`probe:api` sends a synthetic, non-sensitive PNG through the production Context compiler and the
GLM/Qwen provider adapters. It does not start CUA, call `Computer.execute`, or read the desktop.
It performs at most two model requests per provider: a first image request and, only when the
first response contains a parsed ToolCall, a second request with a fixture-labelled result and a
new observation. The second observation is not a claim that an action happened.

Create a disposable image on Windows:

```text
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-nonsensitive-fixture.ps1 -Output runs/api-conformance/non-sensitive-ui.png
```

Run all providers whose keys are present in the selected environment file:

```text
pnpm --filter @computer-harness/cua-driver-spike probe:api -- --env-file ".env" --image "runs/api-conformance/non-sensitive-ui.png" --output "runs/api-conformance/<run-id>" --timeout-ms 120000
```

The probe writes only `summary.json` under ignored `runs/`. It redacts authorization, raw image
data, full model text, and workspace identifiers while retaining message shapes, coordinate
summaries, `finish_reason`, usage, parsed turns, and provider error codes. A 200 response is not
enough for conformance: malformed XML/JSON and incomplete finish reasons remain explicit errors.
