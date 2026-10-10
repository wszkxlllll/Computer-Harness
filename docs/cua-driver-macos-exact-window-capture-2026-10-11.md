# macOS exact-window capture patch (2026-10-11)

The registered Save sheet had its own CGWindow ID, AXSheet role, AX parent window, frame, and ScreenCaptureKit filter. `SCStreamConfiguration` defaults `includeChildWindows` to `true`. With that default, ScreenCaptureKit composited the parent window and attached Save sheet, then returned the family image at the selected sheet's dimensions. The native driver checked output dimensions, so a parent-family image could be accepted as an exact sheet observation and its coordinates were unsafe.

The patch in [`patches/cua-driver/d114f35-macos-exact-window-capture.patch`](../patches/cua-driver/d114f35-macos-exact-window-capture.patch) sets `with_includes_child_windows(false)` when building each exact-window stream configuration. It keeps the selected window ID, identity fingerprint, filter, content rect, point-pixel scale, output dimensions, and input guards unchanged. The focused regression test asserts that child windows are excluded and that the requested width and height are preserved.

A native ScreenCaptureKit matrix reproduced the issue with TextEdit's parent window and attached Save sheet. The default configuration included the sheet when capturing the parent and squeezed the parent-plus-sheet family into the sheet-sized image when capturing the sheet. With `includeChildWindows=false`, the parent capture contained only the parent, and the sheet capture contained only the sheet. The read-only AX relationship was obtained from `AXUIElementCreateApplication(22394)`: `AXFocusedWindow` had role `AXSheet`; its `AXParent` had role `AXWindow`. `AXUIElementGetPid` returned 22394 for both, and the private diagnostic SPI `_AXUIElementGetWindow` mapped them to CGWindow IDs 14759 and 14748, matching `CGWindowList` bounds and ScreenCaptureKit frames. This is diagnostic evidence only; the relationship is not productized as a handoff rule. Private PNG and JSON evidence is in the ignored `runs/astra-autonomous-20261010-sol-luna/A01-private/` directory.

## Source and build identity

- Upstream Cua source: `d114f35fec05ecd37bf529e5587be86852205b64` (Cua Driver 0.22.2).
- Changed native source: `libs/cua-driver/rust/crates/platform-macos/src/capture.rs`, blob `e8fee0477103451914545e60db9097866c4adbcf`.
- Patch SHA-256: `980323a0737626152a27ad0edda2eb0408f944e707f5a63f6094bd74d3e8393b`.
- `Cargo.lock` remained unchanged; `screencapturekit` is locked at 6.0.1.
- Toolchain: Rust/Cargo 1.97.1, offline and locked. Cargo home, Rustup home, and temporary Swift/clang module caches are the existing isolated paths documented in `docs/a-line-sync/diagnostics/F-20261007-005/MANIFEST.md`.

From the Cua Rust workspace root, the candidate was checked with:

```sh
cargo +1.97.1 fmt --all --check
cargo +1.97.1 test --offline --locked -p platform-macos --lib
cargo +1.97.1 build --offline --locked -p cua-driver --bin cua-driver
```

The platform-macos unit suite passed: 345 passed, 2 ignored, 0 failed. The debug driver build succeeded. The candidate is an arm64 Mach-O at `/private/tmp/F-20261007-005-native.eizAWW/target/debug/cua-driver`, 110,529,592 bytes, SHA-256 `cf81ab359cfb2acf38096da455a1fecd3dbbdda5019c6780bcc65cc2b80131b0`. The build emitted existing duplicate `CoreMediaBridge` linker warnings from the locked Apple binding crates; no dependency was changed to suppress them.

After independent source review, the candidate started on the fresh socket `/private/tmp/a01-cua-window-capture-fix.sock` as PID 97824; the stock daemon remained on its original socket. The first exact sheet capture was refused by macOS TCC: ScreenCaptureKit reported that the application was denied screen capture, and the normal shell fallback could not create an image for window 14759. The call returned `px_capture_unavailable`, `screenshot_frame_valid=false`, and AX reported zero AXWindow elements mapped to the requested sheet ID. No screenshot was produced and no input or paid Run occurred. No TCC permission or stock installation was changed. Candidate runtime capture and complete T2 validation remain pending the normal OS permission for this candidate identity.

To keep the permission request distinct from the signed stock application, the candidate executable was packaged as `.tools/cua-driver/CuaDriverCaptureFix.app` with display name `Cua Driver Capture Fix Local Candidate` and bundle identifier `com.trycua.driver.capturefix.local.20261011`. Its ad-hoc signature verifies and has designated cdhash `dc8df6f11f896ea16c313f1549ff2a6a7bee0da3`. The executable SHA-256 after packaging/signing is `a0c49e066d62fe54eaff29facbda658168610f70bb64f582a07351a2f0c8ddc7` (109,905,120 bytes); signing changed it from the raw build hash above. The bundle needs explicit Screen & System Audio Recording and Accessibility grants in System Settings > Privacy & Security. The candidate daemon was stopped normally after the denied probe; the original stock daemon/socket was left untouched. Do not retry candidate capture until those grants are approved.
