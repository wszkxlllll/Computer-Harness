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
