# F015 archive manifest

Base: `d114f35fec05ecd37bf529e5587be86852205b64` (CUA 0.22.2). Cargo.lock SHA256 `cb7cdf7d03eee68f2dd48b6dc75a6005e74ca96a5604a7a88a2994ddd5125a2f`, unchanged. This Windows patch has no Mac or F005 activation changes.

| Asset / frozen source | SHA256 |
| --- | --- |
| native.patch | 0b62d51ce7c8f4fa2b9cbc537d0b1c378c7c04efbe1811ae1e139c4e3b91b47a |
| platform-windows/src/value_append.rs and adjacent copy | 6b1c3fae1aa8cdab6542f07e4078a92fe10649abaecdfa75f03fc8bdfc7d795e |
| platform-windows/src/value_append_independent.rs and adjacent copy | d2415cb72c87f6039c2c4689a2e5f1c02f1f34b14f897c36781f9ea2c2a86b2f |
| platform-windows/src/tools/impl_.rs | c5562e3b2ac5199ee20ca9dd28b665a36d0e54956f2bbbf4f2e3e8e6abc69c28 |
| platform-windows/src/lib.rs | 5d4fd698a640e58446baf24c83e4917f5138f07ebb06d98c8855f0a5a45fba74 |

Source paths are relative to `libs/cua-driver/rust/crates/`. Patch generation used read-only unified diff against the untouched Windows files of the separately frozen d114-based native identity tree, plus complete new-file additions. No Git operation, source-tree edit or clean-apply tree creation was performed in this archive step. New-file copies are exact; lib/impl_ are fully represented by the patch rather than duplicated as large files.

History: first impl_ SHA `2134392bd1023665bcc94ea4a0b3ed4cd500193b87c43f9a309799b1865e57af` contained the Option/Result mismatch. Independent compile-boundary fixture failed with two E0308 errors; Some/None minimal correction produced current impl_ SHA. Adding the original independent tests and cfg(test) path changed the pure module from `2cabf89ad0baf37929e96f39e04ff477a7dbcaf7b1f62415b204dfa24cda6144` to its current SHA, without changing transaction logic.

Final [independent source/replay review](../../fixes/F-20261007-015-review.md), SHA256 `f40617b80456aaa6f23499cf5d4aff7665b487eaf172f3cc72f9fdc51a788bbc`, records actual persistent 20/20 pure std tests, corrected boundary compilation, and read-only clean-replay fingerprint verification. Its earlier source-only revision SHA was `fef00106b3c4e51958943834e1699ffc0621449017a3bcfe66e332d75fca296d`. These are Mac-only pure tests, not Windows target/COM validation. Source author also ran the same final persistent 20/20; repeated executions are not accumulated as extra cases. The original isolated source remains frozen and unchanged by archiving.

Migration verified: coordinator (6) completed clean fixed-base application in `/private/tmp/F015-replay-20261007.XLmRth/source`; all four source hashes above and Cargo.lock matched. First PATH-based rustc invocation exited 127 before compilation; this failed attempt is retained, not counted as a compiled test. Using the existing absolute rustc 1.97.1 path then compiled the replay pure std target with exit 0 and ran 20/20 tests with exit 0, with pre/post source and lock hashes unchanged. Independent reviewer only read and verified replay fingerprints. This supersedes the initial migration-pending archive state; patch and source-copy bytes remain unchanged. F004 remains closed; Windows cfg/COM compilation, real UIA and full platform acceptance remain unverified. No Windows candidate, SDK, COM, GUI or actual application invocation occurred.
