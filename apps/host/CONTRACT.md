# Mobile Host API Contract

The Host owns the `ApplicationSession`, pairing state, device sessions, command
receipts, and an allowlisted projection of each Run. It does not expose
Provider credentials, local file paths, CUA identifiers, or raw trajectory
events to a paired browser.

The direct API and the authenticated Relay bridge use the same normalized
`GET`, `POST`, and `DELETE` routes. The Relay must reject `/api/local/*` before
forwarding any request and must never act as an arbitrary HTTP proxy.

## Pairing

- `POST /api/local/pairing` creates a cryptographically random one-use token
  that expires after 90 seconds. The response is `{ challengeId, pairingUrl,
  expiresAt }`. Only the loopback desktop UI can see the raw URL.
- `GET /api/local/pairing` returns the active challenge metadata and pending
  requests. `GET /api/local/session` returns the short-lived local CSRF token.
- `POST /api/pair/requests` accepts `{ token, clientName }` and returns 202 with
  `{ requestId, status: "pending_local_confirmation", expiresAt }`. A token is
  consumed by the first valid request. It grants no control until local
  confirmation.
- `GET /api/pair/requests/:requestId` returns one of
  `pending_local_confirmation`, `approved`, `rejected`, or `expired`.
- `POST /api/local/pairing/requests/:requestId/confirm` accepts
  `{ approved, label? }`. Only an explicit local approval creates a device.
- `POST /api/pair/requests/:requestId/session` can run only after approval. It
  sets an HttpOnly, SameSite=Strict cookie and returns `{ deviceId, csrfToken,
  expiresAt }`. `GET /api/session` restores this UI state after reload;
  `DELETE /api/session` revokes the device session.
- `GET /api/local/devices` lists paired devices and `DELETE
  /api/local/devices/:deviceId` revokes one immediately.

Local administration requires a loopback peer, an exact loopback Origin, and a
CSRF token. Public state-changing requests require a same-origin Origin,
HttpOnly session cookie, and `X-CSRF-Token`. When bridged through the Relay,
the Host accepts the normalized request only over the authenticated Host
connection and validates the Host-issued opaque session token itself.

## Runs

- `GET /api/windows` enumerates the currently visible CUA windows using a
  temporary read-only discovery session. It returns only `{ token, appName?,
  title? }` labels plus `expiresAt`; PID, HWND, bounds, and native identifiers
  never cross the Host boundary. Tokens are random, device-bound, single-use,
  valid for ten minutes, and all prior tokens for that device expire whenever
  the list is refreshed.
- `POST /api/runs` accepts exactly `{ commandId, goal, targetToken }`; an
  initial target choice is mandatory. Before creating the Run, Host performs a
  fresh CUA inventory and verifies that the same PID/HWND and safe labels still
  identify the selected window, then configures foreground delivery for that
  exact target. A stale, expired, used, changed, or missing choice returns
  `409 WINDOW_TARGET_STALE`; discovery failure returns 503. The Host never
  falls back to the default desktop target. Repeated command IDs return the
  original Run and never start another one.
- `GET /api/runs` and `GET /api/runs/:runId` return safe snapshots, including
  the final reply and selected window's safe title/app label after completion.
  A snapshot has a monotonic projection `sequence`; it is not the raw Runtime
  event sequence.
- `GET /api/runs/:runId/events?after=<sequence>` streams allowlisted SSE events.
  A cursor gap emits `resync_required`; the client then fetches the snapshot.
- `POST /api/runs/:runId/commands` accepts a `commandId`, `expectedSequence`,
  and one typed command. Approval and window decisions also include the exact
  pending `requestId`; window selection uses an opaque short-lived candidate
  token, never a client-supplied PID/HWND.
- Command submission acknowledges `accepted` separately from its eventual
  `applied`, `rejected`, or `outcome_unknown` receipt. `GET
  /api/runs/:runId/commands/:commandId` reads that receipt after reconnect.
- `GET /api/runs/:runId/assets/:assetId` returns only an asset already
  referenced by that Run's authorized observation; clients never choose a
  filesystem path. The Host checks path components and resolved-path
  containment under the Run's asset root, rejecting symlink/reparse traversal.
  A hostile local writer racing the file open remains outside portable Node's
  complete protection; the Host reads through the opened file handle and
  rechecks identity/containment to narrow that local TOCTOU window.

## Voice input (B2 preview)

Voice input is a paired-device Host service, outside Runtime, Guard, and Computer.
The Host owns the provider credential and recognition session. All state-changing
routes require the same paired session cookie/token and CSRF checks as Run
commands; the Relay allowlists these exact routes and does not store audio or
transcripts.

- `GET /api/voice/capabilities` returns availability, 16 kHz mono PCM format,
  recommended 3,200-byte chunks, the provider's stable ID, and the maximum
  recording duration. This is a local configuration/capability read, not a live
  probe of the remote ASR service. An absent provider configuration returns
  `{ available: false, unavailableReason }`.
- `POST /api/voice/sessions` accepts exactly `{ requestId }`. Host generates a
  random session ID, binds it to the authenticated device, and permits one active
  session per device. A repeated start request ID returns the existing session.
- `POST /api/voice/sessions/:sessionId/audio` accepts exactly
  `{ chunks: [{ sequence, audio }], afterEventSequence }`. `chunks` must contain
  1–4 ordered items, each at most 4,096 bytes of canonical Base64 little-endian
  PCM16. Sequence numbers start at zero and must be contiguous. The Host
  prevalidates the whole batch before forwarding any new chunk, so a conflict or
  gap later in a batch cannot silently accept its valid prefix. An exact retry is
  acknowledged without being resent to the provider. This B2 preview accepts no
  legacy single-chunk request shape; Host, Relay, and Web must use the same batch
  contract version.
- `POST /api/voice/sessions/:sessionId/finish` and `/cancel` accept exactly
  `{ afterEventSequence }`. Finish flushes provider recognition and returns final
  transcript updates only after the provider's terminal `session.finished` event.
  Finish and cancel are idempotent.

Chunks are bounded to 4,096 bytes; the default 100 ms block is 3,200 bytes.
The browser sends the first chunk immediately; chunks produced while one request
is in flight are grouped into the next batch (up to four) and drained in order.
The aggregate request stays below the Relay's 32 KiB JSON limit. Total audio is
capped at 1,920,000 bytes / 60 seconds, measured from the first accepted audio
chunk. The 60-second content/byte cap remains strict. While recording, the Host
allows a separate 10-second bounded transport grace after that point so a final
captured batch can reach the Host; this does not permit more audio bytes. A
session with no audio has a 60-second initial/idle grace for microphone
permission and startup; recording sessions also have an idle timeout. Once
finalizing, the Host does not age-expire the provider wait; the existing finish
timeout bounds it. Active-session count, event buffer, and terminal retention
are bounded. Raw audio exists only in the browser's bounded live upload queue
and current request/Provider send path;
the queue zeroes its PCM buffers after send/cancel. The Host retains only chunk
digests for duplicate detection. Transcript events remain in bounded Host memory
for the active session and are returned only to that paired device. Nothing is
written to Run trajectory, screenshots, or logs. Device revocation and Host
shutdown cancel active provider sessions.

The initial adapter is Qwen3-ASR-Flash-Realtime over the Host-owned secure
WebSocket. Configure `DASHSCOPE_API_KEY` and the workspace-specific
`DASHSCOPE_REALTIME_ASR_ENDPOINT` in the Host's private environment file;
`DASHSCOPE_WORKSPACE_ID` is optional when the endpoint already scopes the
workspace. The browser never receives these values. This preview uses JSON HTTP
Relay requests for each audio block; moving the upload stream onto one Relay
WebSocket is a later transport optimization.

Public JSON requests are limited to 32 KiB. Asset responses are limited to
8 MiB. The Host retains start idempotency keys for up to 4096 accepted or
failed start attempts per process and up to 1024 command IDs per Run; it never
evicts a key to make room. At a limit it rejects new starts/commands with 429,
while duplicate IDs continue returning their original Run/receipt. SSE cursors
count projected events only, so filtered internal events do not create gaps.
The projection omits arbitrary model text, action payloads, Provider errors,
and local paths; the Run's final user-facing summary and authorized screenshots
remain available.

The pairing/device, Run, and command-deduplication stores are process-memory
only. A graceful Host shutdown attempts to cancel the active Run; after a crash
or forced termination, the action outcome may be unknown. Restart invalidates
sessions, Run snapshots, and deduplication state, so recovery requires local
inspection and a fresh pairing; the Host never automatically replays a command
or restarts a Run. The Relay does not queue or replay an uncertain GUI command.
