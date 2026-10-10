# F-20261011-071 — macOS browser focus proof

## Finding

On macOS, `get_window_state` intentionally reports `elements_complete=false`: its actionable AX projection cannot prove that the remainder of the native accessibility tree was read. After `CMD+L`, Chrome can focus its address field even though the actionable projection contains no focused row. The existing computer gate therefore failed closed before typing, despite the native OS exposing an exact focused AX element.

## Change

The macOS driver adds an optional, versioned `focus_proof` to `get_window_state.structuredContent`. It is emitted only when the frontmost PID, focused AX window, WindowServer owner, AX focused element PID, bounded AXWindow/AXParent ancestry, enabled/editable state, and full screen-point geometry all agree on the exact requested browser window. The driver rechecks the focused AX element, frontmost PID, focused window, owner, and window bounds before emitting it. The proof is tied to that response's `snapshot_id`; it contains no AXValue and does not change the actionable catalog's completeness.

The computer adapter accepts this proof only when the health report identifies macOS, the proof's target and snapshot exactly match the current response and host binding, and its native frame is wholly inside the exact bound window. It projects that frame through the existing native-bounds-to-viewport transform without clipping, then applies the existing address-bar role/name and browser-chrome checks. It still requires a complete same-tab DOM observation with no focused page control. The prior complete-catalog path is unchanged. Existing one-shot input permission and live fingerprint recheck remain in force.

## Verification

- `cargo +1.97.1 fmt --all` passed.
- `cargo +1.97.1 check --offline --locked -p platform-macos` passed.
- `cargo +1.97.1 test --offline --locked -p platform-macos --lib tools::get_window_state::focus_proof_tests` passed (2 tests).
- Independent review ran the complete `platform-macos --lib` suite: 347 passed, 2 ignored, 0 failed; `fmt --check` passed.
- `pnpm typecheck` passed.
- `pnpm exec vitest run packages/computer-cua/src/cua-driver-computer.test.ts` passed (284 tests), including 20 focused-proof cases. Independent review also passed the computer and SDK tests (298 total).
- `git diff --check` passed. The two focus-only patch files and the pre-existing capture patch separately passed `git apply --check` against clean `d114f35fec05ecd37bf529e5587be86852205b64`; applying them reproduced the exact source-file SHA-256 values used for the candidate build.

## Candidate boundary

The combined capture-and-focus candidate is packaged at `.tools/cua-driver/CuaDriverCaptureFix.app`. It reuses the existing local candidate bundle identifier `com.trycua.driver.capturefix.local.20261011` and has display name `Capture and Focus Fix Local Candidate`; its embedded arm64 binary SHA-256 is `4f3f99d9ef6c91da9203ca202e70a2b2cc5682b784dd5d92921bcf5fbc414ebc`. Ad-hoc signature verification succeeded. The candidate was not launched or installed, and no TCC settings or grants were read or changed. Live OS permission behavior remains unverified pending the user's Accessibility and Screen Recording authorization.

The focus-only patch is committed at `patches/cua-driver/d114f35-macos-focused-element-proof.patch`. The pre-existing capture patch remains a separate repository input at `patches/cua-driver/d114f35-macos-exact-window-capture.patch`; applying both repository patches to clean `d114f35fec05ecd37bf529e5587be86852205b64` reproduces the source used for this candidate build.
