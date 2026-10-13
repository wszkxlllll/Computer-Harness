# F-20261007-005 offline activation diagnostics

This directory retains the offline-only diagnostic patch and receipt-observer fixtures for I-20261007-002. The candidate adds bounded fields from the already selected frontmost row in the same native observation. It does not change activation acceptance, verification, error/status mapping, or polling, and it does not identify the source of the transient window IDs.

## Fixed source and files

The patch is based on CUA source commit `d114f35fec05ecd37bf529e5587be86852205b64` and changes only `platform-macos/src/tools/bring_to_front.rs`. The native output field is `observed.frontmost_window_diagnostic`, schema `cua.frontmost_window_diagnostic.v1`, source `observe_exact_window_existing_visible_windows_snapshot`. `native.patch` contains the exact upstream diff; source/ref review, any future patch application, and Git operations remain coordinated by role (6).

The JavaScript observer is a temporary adapter-boundary fixture. It projects only fixed schema/source, numeric target/frontmost IDs and window metadata, booleans, and relationship enums. It requires the diagnostic ID to match the legacy frontmost ID in the same receipt and verifies both target relations against the same structured receipt. It returns the original native Promise and does not alter non-`bring_to_front` calls. Its `connectDriver` must be supplied by an authorized public SDK boundary; this fixture is not wired into production `createComputer` and was not run against an SDK, daemon, or desktop.

## Offline verification

Run the two synthetic Node suites from this directory:

```sh
node --test activation-receipt-observer.test.mjs
node --test wrapper-review-independent.mjs
```

The author suite passed 8/8 and the independent suite passed 9/9 (17 total, no failures) against the retained observer. This proves only the synthetic wrapper behavior.

The test role's isolated native check and pure-module test passed; see [T-20261007-014](../../tests/T-20261007-014.md) for the exact environment and result. The Rust test executable was built for that module run. T-20261007-015 then built one offline debug `cua-driver` candidate successfully: SHA-256 `e3e15bef9c676d0ab3d06830fa177bf51191af69ec48d62caed460fac3b3bc3e`, arm64, 110,516,040 bytes, unoptimized with debug info. Swift CoreMediaBridge and rpath warnings remain recorded. The binary was not executed (including help/version), signed, installed, or used to replace the SDK/driver/Host. Any daemon load, switch, deployment, or restart still requires specific human authorization.

## Open boundary

I-20261007-002 remains open. The production Runtime/SDK receipt path has not been connected to this diagnostic, the transient HWND source remains unknown, and no fresh production activation evidence exists. The candidate does not authorize a daemon switch, deployment, or restart; those require specific human authorization and coordination with (6)/(10).
