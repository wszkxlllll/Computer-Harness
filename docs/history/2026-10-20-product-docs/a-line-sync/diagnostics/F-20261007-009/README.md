# F009 restricted read-only evidence client

This candidate implements two bounded Unix-socket queries and a pure validator.
It is **not** a live launcher or the F008 lifecycle adapter. Importing the module
or creating the client has no filesystem/socket effect. Calling `inspect` is an
explicit operation on the supplied endpoint. There is no CLI, SDK import,
native spawn, daemon startup, signal/kill, shutdown, runner dispatch, token,
capture, input, permission prompt, TCC edit, build, or automatic retry.

The public exports are `createReadonlyEvidenceClient({fs, connect, clock, uid})`
and `validateEvidence({metadata, permission, expected})`. The defaults use Node
filesystem reads, Node `net.createConnection`, and monotonic `performance.now`.
The client exposes only `inspect({socketPath, expected, timeoutMs, signal})`.
`expected` contains exactly `{pid, parentPid, executable}`; it is snapshotted
before asynchronous work. Other request/identity keys are rejected. No method,
tool, params, raw body, fallback endpoint, reconnect, or arbitrary command can be
supplied. `timeoutMs` is a positive integer at most 30,000, covering all file
checks and both queries together. Abort or timeout closes the pending connection
and prevents late results from connecting again. JavaScript timers cannot
preempt blocked synchronous code, and cancellation does not establish that
work already sent to a daemon has finished.

The socket must be an explicit, normalized absolute path beneath a directory in
`/private/tmp/`, within the bounded Unix path length. The immediate parent must
resolve to itself, be a non-symlink directory owned by the supplied current UID,
and have mode 0700. The socket must be non-symlink, current-UID-owned, mode 0600,
with valid device/inode. Parent and socket identity are checked before, between,
and after the requests. Replacement or missing evidence fails closed. These
checks are point-in-time filesystem evidence, **not** an atomic binding to the
connected peer; replacing an endpoint between checks remains an unproven case.

Only these native line-delimited JSON requests are possible, in order, each on
a fresh connection that is closed after its first reply:

```json
{"method":"metadata"}
{"method":"call","name":"check_permissions","args":{"prompt":false,"probe_direct_capture":false}}
```

The fixed source protocol does not echo request IDs. Replies are bounded to
64 KiB including the newline, parsed with fatal UTF-8 decoding, and require one
JSON object. Multiple frames in the received reply are rejected; events arriving
after the first complete reply/closure are ignored, including late errors. No
reply-ID correlation or proof about future bytes is claimed. Requests are never
overlapped on the same connection. Error messages, MCP text, paths, raw bodies,
bundle labels and version strings are never placed in the returned summary.

Native `DaemonMetadata` uses snake_case version fields, PID and embedded status.
Invalid or mismatched metadata stops before the permission query. Success
envelopes containing `error` or `exit_code` are contradictory and rejected,
for both metadata and permission replies.
The permission tool is inside `{ok:true,result:{structuredContent:...}}`, with
`accessibility`, `screen_recording`, and `source`. Its PID/PPID/executable must
match the caller-supplied expectation. The read-only response must explicitly
report `screen_recording_capturable:null`, `direct_capture_status:"not_checked"`
and `direct_capture_error:null`. A caller attribution, unknown source, missing
grant, mismatched identity or direct-probe evidence yields a fixed refusal code.

Even perfectly matching positive reports return
`permissionOwnership:"unverified"` and `readyForDispatch:false`. Source bundle
paths and responsibility environment flags are heuristics. The socket metadata
and permission result are self-reports: they do not prove authenticated peer
PID, process start/executable hash, parent ownership, TCC responsible identity,
or that startup never prompted. No F008 pass/token is issued. A positive AX/CG
preflight result does not establish live capture readiness; that probe is
deliberately excluded. A native request may also update aggregate telemetry,
so "read-only" describes desktop/permission behavior, not all daemon internals.

Fixed source evidence inspected for this contract:

- `cua-driver-core/src/daemon.rs`: metadata and daemon envelopes.
- `cua-driver-core/src/protocol.rs`: `isError`/`structuredContent` serialization.
- `platform-macos/src/tools/check_permissions.rs`: prompt=false excludes request
  APIs and ScreenCaptureKit, and source attribution is heuristic.
- `platform-macos/src/permissions/status.rs`: AX and CG preflight probes act for
  the current process.
- `cua-driver/src/responsibility.rs`: standalone responsibility child, outer
  waitpid parent, and exit mirroring.
- `cua-driver/src/main.rs`/`serve.rs`: socket binds before the permission gate,
  and graceful shutdown is separate from TERM/process exit.

No claim is made that Darwin lacks atomic process APIs. Peer/audit-token and
exact process/TERM semantics require a separately reviewed native mechanism.
F008 integration, real startup/cleanup, stable TCC identity and a new diagnostic
authorization remain outstanding. Those cannot be inferred from this client.

Run fixture-only verification from this directory:

```sh
node --check readonly-evidence-client.mjs
node --check readonly-evidence-client.test.mjs
node --test readonly-evidence-client.test.mjs
```

All author tests inject fake filesystem, EventEmitter sockets and fake monotonic
clocks. They never create a real socket/mock server or run native code. This
candidate has not been connected to any live endpoint and does not authorize a
new live run. F005/F006/F008 and business source/dist/native remain unchanged.
