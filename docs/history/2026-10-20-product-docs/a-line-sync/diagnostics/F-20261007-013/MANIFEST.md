# F013 archive manifest

Base: `d114f35fec05ecd37bf529e5587be86852205b64` (CUA 0.22.2). Cargo.lock: `cb7cdf7d03eee68f2dd48b6dc75a6005e74ca96a5604a7a88a2994ddd5125a2f`, unchanged. Archive contains no F005 activation changes.

| Asset / frozen source | SHA256 |
| --- | --- |
| native.patch | b5b06835e4faf946a6a2658d1aa3d519f617ff3e4baa17a2e89b1091a1e40bf3 |
| platform-macos/src/diagnostic_preflight.rs and adjacent copy | acd9722f15e8cfc7b1134f39ff274ab94fc8206b3eac31ab9e3b761bfe29de32 |
| platform-macos/src/diagnostic_preflight_independent.rs and adjacent copy | dd525c9485093de13c8c1b9d7d7e366a219646b3eea6fcb912620dc39b066bd1 |
| platform-macos/src/lib.rs | ed1fc64ee31259b09abeb1b026d29bc2680128897f10fc94d4a49e541cca8aa0 |
| cua-driver/src/main.rs | bcecd85aa51496d16da56e37a073a3a729a5d49e0c5c332b498267dfcb5ce13f |

All source paths above are under `libs/cua-driver/rust/crates/`. Patch mechanically combines tracked main/lib diff and complete new-file additions, including the independent test module; archive copies match source bytes. Original isolated source is unchanged by archiving.

Evidence is separate, not interchangeable:

- [T023](../../../../../a-line-sync/tests/T-20261007-023.md): offline/locked check and build, 20/20 fake tests. Unsigned/debug build SHA `bfe43b3be8d06cbdd007126b64d49a53dda2777e098f716a4a20a3afcedf9e9d` (110592088 bytes).
- [T024](../../../../../a-line-sync/tests/T-20261007-024.md): separately prepared ad-hoc signed copy SHA `46db151bd19763013eda935170be0fe1d408d9b7719d0aa4b0e0d0c1a72ed53e` (109967264 bytes). This does not substitute T020/F005 binary evidence or actual preflight execution.
- [Independent source/build/replay review](../../fixes/F-20261007-013-review.md), SHA256 `736e82eff048a6be11f3639d642e4aed33133aeaf446df0c352f3c3c31753672`: source and lock consistency, fake-only scope, and read-only replay fingerprint verification.

Migration verified: coordinator (6) used clean fixed-base `/private/tmp/F013-replay-20261007.iFzd3N/source`; patch check and application each exited 0, all four source SHA256 values above plus Cargo.lock matched, and diff whitespace check exited 0. Independent review only read and checked the resulting fingerprints; it did not reapply, build or execute a candidate. This replaces the initial archive migration-pending state without changing patch/source/test-copy bytes. T023's 20 fake tests and T024 signing remain separate historical evidence, not new replay test results.

First source freeze `9d96d3bc...` was superseded before compilation: failure CopySigningInformation status now refuses before wrapping an output with undocumented error ownership. Successful nonnull outputs alone use Create-rule. The original independent tests are unchanged.
