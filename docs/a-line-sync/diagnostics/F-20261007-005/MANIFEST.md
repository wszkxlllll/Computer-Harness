# F-20261007-005 offline diagnostic preparation manifest

Status: source candidate, temporary observer, native tests, and one offline debug daemon build verified; candidate remains unexecuted and undeployed. Daemon loading, switch, deployment, or restart is not authorized.

## Fixed source and candidate

- Upstream commit: `d114f35fec05ecd37bf529e5587be86852205b64`.
- Isolated source checkout HEAD: `d114f35fec05ecd37bf529e5587be86852205b64`.
- Modified native file in the temporary source checkout (not included in this archive): `/private/tmp/F-20261007-005-native.eizAWW/source/libs/cua-driver/rust/crates/platform-macos/src/tools/bring_to_front.rs`.
- Upstream file SHA-256 (before patch): `1ffc9ff1fefbe20bd20c08d01ba062fee5d9082291b56f5bcf48631ec9e7404f`.
- Candidate native file SHA-256: `a3c1e61f5dbd6f16f8446fc1ac548d1174b0ce5b6132cd424654e313a6661285`.
- Patch: persistent `native.patch`, SHA-256 `ae5c31d9e6c3173e0a41e9751a1cd96befcc3a923222f7852bc7e2ffc37fb07f`. Historical check in the temporary source checkout: `git apply --reverse --check upstream.patch` passed against the candidate checkout; the checkout itself is not included in this persistent artifact bundle.
- Fixed output field: `observed.frontmost_window_diagnostic`; schema `cua.frontmost_window_diagnostic.v1`; source enum `observe_exact_window_existing_visible_windows_snapshot`.
- Native change is limited to same-observation projection from the existing selected `visible_windows()` row and tests in `bring_to_front.rs`. No new enumeration, AX query, polling, gate, result status, error, or deployment change.

## Temporary receipt observer

- `activation-receipt-observer.mjs`, SHA-256 `2116e0e5e67d374e678e750530927687f2e46216c7a097bf363775fa115355c5`.
- `activation-receipt-observer.test.mjs`, SHA-256 `a95a74d50404196a02f7e78bd0d58100815c8a0a3b6702d9b79a4ffcacb4937d`.
- `wrapper-review-independent.mjs` (local import adjusted only), SHA-256 `2608d3390af480547aea15b711e64482f8930d3dbba687602489fc78a04db762`.
- Author-run command: `node --test activation-receipt-observer.test.mjs` from this persistent directory.
- Author result: 8 tests passed, 0 failed. Coverage includes original Promise/result/rejection identity, exact arguments and cancellation signal, original driver factory and lifecycle receiver, non-target method bypass, same-receipt target/legacy/relationship consistency, malformed/oversized/private fields, and sync/async sink failure isolation. These are synthetic Node tests only; no real SDK, native driver, desktop, daemon, or service was invoked. This temporary observer is not wired into the business application.
- Independent wrapper review: `wrapper-review-independent.mjs`, 9 tests passed against the final observer hash. The independent script is retained beside the observer with its single module import adjusted for this persistent directory.

Author and independent suites were rerun against the final persistent observer and test hashes: `node --test activation-receipt-observer.test.mjs` passed 8/8, and `node --test wrapper-review-independent.mjs` passed 9/9 (17 total, 0 failures). These are synthetic Node tests; they do not invoke a real SDK or native driver.

## Independent native crate verification

The test role recorded [T-20261007-014](../../tests/T-20261007-014.md) against the same fixed native file SHA and patch SHA. With the authorized toolchain and the isolated target/module-cache paths above, `cargo +1.97.1 check --offline --locked -p platform-macos` exited 0 in 13.57 seconds. Then `cargo +1.97.1 test --offline --locked -p platform-macos --lib tools::bring_to_front::tests` exited 0: 12 passed, 0 failed, 339 filtered; test binary build 47.44 seconds, execution 0.00 seconds. This is only the selected pure Rust module test target.

The Swift build emitted a CoreMediaBridge duplicate-symbol linker warning; the check/test commands nevertheless exited 0. Keep that warning visible: no dependency was changed to suppress it, and it does not establish that a daemon can link, start, or run. After T014 verification, the native source SHA, patch SHA, and Cargo.lock SHA matched the recorded starting values; only the intended native source file was dirty. At that T014 stage, no daemon candidate was built; T015 later built the debug candidate recorded below, which remains unexecuted and undeployed.

## Native check attempts

Toolchain: existing Rust `1.97.1`; Cargo home `/Users/guoyuhang/Desktop/大创/Computer-Harness/.tools/rust-toolchain/cargo`; Rustup home `/Users/guoyuhang/Desktop/大创/Computer-Harness/.tools/rust-toolchain/rustup`; auto-install disabled. All outputs target `/private/tmp/F-20261007-005-native.eizAWW/target`.

Attempt 1 used `cargo +1.97.1 check --offline --locked -p platform-macos` without Swift module cache overrides. It failed in Swift dependency build scripts when SwiftPM attempted to write the user clang module cache.

Attempt 2 used these additional temporary environment values:

```text
SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/F-20261007-005-native.eizAWW/swift-module-cache
CLANG_MODULE_CACHE_PATH=/private/tmp/F-20261007-005-native.eizAWW/clang-module-cache
```

The Swift compiler command confirmed that the module cache path was redirected to the isolated tmp directory. SwiftPM then stopped at `sandbox-exec: sandbox_apply: Operation not permitted`. No elevation, sandbox disabling, dependency changes, network access, or installation was used. These were the author's earlier attempts before the test-role offline build; they failed before crate verification.

## Exact offline commands for the authorized builder

From `/private/tmp/F-20261007-005-native.eizAWW/source/libs/cua-driver/rust`, after retaining the isolated paths above:

```sh
env \
  CARGO_HOME='/Users/guoyuhang/Desktop/大创/Computer-Harness/.tools/rust-toolchain/cargo' \
  RUSTUP_HOME='/Users/guoyuhang/Desktop/大创/Computer-Harness/.tools/rust-toolchain/rustup' \
  RUSTUP_TOOLCHAIN=1.97.1 \
  RUSTUP_AUTO_INSTALL=0 \
  CARGO_TARGET_DIR='/private/tmp/F-20261007-005-native.eizAWW/target' \
  SWIFTPM_MODULECACHE_OVERRIDE='/private/tmp/F-20261007-005-native.eizAWW/swift-module-cache' \
  CLANG_MODULE_CACHE_PATH='/private/tmp/F-20261007-005-native.eizAWW/clang-module-cache' \
  '/Users/guoyuhang/Desktop/大创/Computer-Harness/.tools/rust-toolchain/cargo/bin/cargo' \
  +1.97.1 check --offline --locked -p platform-macos
```

Only after that crate check succeeds, run the hermetic module tests:

```sh
env \
  CARGO_HOME='/Users/guoyuhang/Desktop/大创/Computer-Harness/.tools/rust-toolchain/cargo' \
  RUSTUP_HOME='/Users/guoyuhang/Desktop/大创/Computer-Harness/.tools/rust-toolchain/rustup' \
  RUSTUP_TOOLCHAIN=1.97.1 \
  RUSTUP_AUTO_INSTALL=0 \
  CARGO_TARGET_DIR='/private/tmp/F-20261007-005-native.eizAWW/target' \
  SWIFTPM_MODULECACHE_OVERRIDE='/private/tmp/F-20261007-005-native.eizAWW/swift-module-cache' \
  CLANG_MODULE_CACHE_PATH='/private/tmp/F-20261007-005-native.eizAWW/clang-module-cache' \
  '/Users/guoyuhang/Desktop/大创/Computer-Harness/.tools/rust-toolchain/cargo/bin/cargo' \
  +1.97.1 test --offline --locked -p platform-macos --lib tools::bring_to_front::tests
```

T-20261007-015 executed one authorized offline debug driver build with the same Rust toolchain, `--offline --locked`, `CARGO_TARGET_DIR`, and temporary Swift/clang module-cache environment above:

```sh
cargo +1.97.1 build --offline --locked -p cua-driver --bin cua-driver
```

It exited 0 in 26.76 seconds. The resulting debug candidate SHA-256 is `e3e15bef9c676d0ab3d06830fa177bf51191af69ec48d62caed460fac3b3bc3e`, architecture arm64, size 110,516,040 bytes, unoptimized with debug info. Source SHA and Cargo.lock SHA remained unchanged. Swift CoreMediaBridge duplicate-symbol and rpath warnings were retained. The binary was not executed, including help/version, and was not signed, installed, or used to replace SDK/driver/Host. Building this candidate does not establish daemon runtime behavior or production readiness; loading or switching remains gated by specific human authorization.

No daemon deployment, switch, restart, GUI, API, or production receipt occurred. The underlying issue remains open; offline diagnostics do not explain the transient window IDs or establish production behavior.
