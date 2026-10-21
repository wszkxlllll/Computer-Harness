# F-008 phase controller prototype

This is an offline-only, pure orchestration controller. It imports no process
launcher, SDK, native binding, network client, or desktop API; it does not copy,
spawn, kill, unlink, grant permissions, or read configuration. Every lifecycle
effect is represented by an injected adapter and the tests use only fake
children and a fake clock. A passing test is not proof that any native adapter
or permission check is correct.

The phase order is `idle → starting → awaiting_review → rechecking →
dispatching → dispatched`. Startup has a hard maximum of 30 seconds and its
deadline timer is armed before calling the adapter. Timeout or any missing,
invalid, false, prompted, or unknown identity/permission evidence fails closed.
The controller never dispatches automatically from `awaiting_review`.

An approval token is an opaque, controller-issued object held in a WeakMap. It
is bound to child PID/parent PID/start identity/executable path and SHA-256,
parent PID/start identity/executable identity, socket path/device/inode/owner/
mode, and the permission snapshot. It expires after the configured short TTL,
is consumed before fresh checks, and cannot be reused or substituted by a
lookalike object. Dispatch requires a separate explicit approval object with
`approved: true` and `prompt: false`, then a fresh exact identity and
permission match. Concurrent reviews cannot produce more than one dispatch.

The injected adapter contract is safety-critical: `inspect` must return a
fresh, exact identity; `terminateExact` must synchronously recheck the bound
PID/start/executable identity and send only TERM if it still matches; and
`waitForExit` must confirm each exact process exit. Cleanup is one bounded
five-second child-then-parent sequence. The controller does not signal either
process when identity is absent or changed, never advances to parent TERM
unless child exit was confirmed, and reports `pending_cleanup` if identity,
dispatch settlement, or exit cannot be confirmed. A late startup result is
eligible only for bounded cleanup and never returns to the review/dispatch
phase. This prototype has no real adapter and therefore cannot establish
process ownership, native permission state, socket identity, or cleanup in a
live environment.

Run only the synthetic tests with:

```sh
node --check diagnostic-launcher.mjs
node --check diagnostic-launcher.test.mjs
node --test diagnostic-launcher.test.mjs
```


## Adapter and timer limitations

This is a phase controller only. No real lifecycle adapter, child-process ownership check, OS permission query, SDK connection, or dispatcher is included or validated. A token records sequencing and snapshot equality; it is not a human authorization credential. JavaScript timers cannot preempt a synchronous or non-cooperative native call. An adapter that cannot promptly honor deadlines/cancellation must remain pending/unknown; the controller's timer is not proof that the process stopped.
