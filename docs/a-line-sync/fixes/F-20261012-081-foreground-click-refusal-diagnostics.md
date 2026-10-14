# F-20261012-081 — Exact foreground click refusal diagnostics

Status: native build/replay, independent binary review, live health and refusal-diagnostic journal validation passed. This is an observability change, not proof that T3's original refusal cause is fixed.

The A06 T3 baseline ended cancelled after three native click refusals. The existing message combined exact foreground/focus and point occlusion, while the production adapter retained only the refusal code/message. Two separate owned-browser zero-Provider probes succeeded, including a 10-second delayed click; they do not explain the earlier Run.

## Implementation boundary

Only the existing foreground, single left-button, count=1, no-modifier pixel route gains a structured `guard_diagnostic` on refusal. The same sampled foreground PID, focused CGID and WindowServer point report drive the original guard decision and the diagnostic. Original refusal text, input dispatch, cursor behavior and success response remain unchanged. Focus mismatch records point testing as not evaluated. The report contains numeric identities, geometry, scale, the exact published click-through overlay and first blocking row; it excludes titles, URLs, application names and document values.

`read_status=ok` means the CG API returned a snapshot. It does not prove complete or valid global inventory. `malformed_row_count` counts discarded non-dictionary raw rows, not every invalid field. Missing focus remains unavailable, not evidence of another app.

The A06 private journal observes only click errors with this exact diagnostic schema, either resolved `isError` or the SDK Tool exception path. It projects fixed fields/enums and bounded numbers, delegates once, preserves this/arguments and the original Promise/result/exception, and ignores journal-write failure. Successes and invalid diagnostic shapes do not produce click diagnostic entries. An omitted diagnostic is not proof the point was safe.

## Validation

- Author: five targeted native tests and formatting passed on click source `9e538658…` and windows source `0e711961…`; final native regression passed 370 tests with 2 ignored.
- Sol independent: journal, CLI starter and Host starter tests passed 18/18, exit 0. Preload SHA `9d6dee12b39b55beccf92a1482882d8131129ed7d10bc188b09d0ac29b0cf00f`.
- Sol independently compared the actual native7 clean replay with current two-file increment: guard boolean and original messages preserved, no new activation or dispatch. Private receipt: `A06-private/sol-native8-journal-independent-review.json`.

## Reproducibility correction

Two initial private replay attempts were invalid: the temporary archive was inside the main checkout and inherited its parent Git repository. `git apply --check --verbose` explicitly reported skipped patches while returning zero. The resulting mismatches were a checker artifact, not proof that the earlier functional patches were missing. Sol compared all five suspected files in the actual isolated native7 replay against current source and found their SHA256 values identical. The mistaken missing-function conclusion is withdrawn; failed receipts remain preserved.

The corrected replay uses an isolated `/private/tmp` archive with its own Git metadata, validates the six ordered patch hashes, then applies the complete native8 delta. It reports 11 delta paths and all 17 touched sources matching the candidate. Complete patch SHA: `650bb5c57f538972ddabbcef673ab65e38bd011996fd43b91424c0ad3f465d5e`. This is an alternative after-six closure; do not stack it after native7. The old native7 artifact remains unchanged.

Author full platform regression: 370 passed / 2 ignored / 0 failed. Formatting, platform check, platform release and actual cua-driver release build all completed with exit 0. The complete deliverable is [native8 after-six closure](../../../patches/cua-driver/d114f35-macos-document-and-click-diagnostics-complete.patch); apply it after the first six functional patches instead of native7, not on top of native7.
The preceding source-review stage used no Provider request or live replacement. The subsequent signed candidate and live diagnostics are recorded below. A06 remains actual 32 main / 0 risk; cumulative actual requests remain 371, with 345 known usage responses and 26 unknown.

## Signed candidate and real SDK evidence

Release SHA256 `2d35bd74994cd389235e1614b348b11bdd27aeb732468ae524930873fdbce301` was copied to the independent CaptureFix App and ad-hoc signed; signed SHA256 is `6f56f90e516a3d410c77f8bfc739f3aa0af4a4f68b7004e63d0913858aa58722`, CDHash `a47177f46d26c25830f258627c0ffe7fe9ad019d`. Root independently matched all 40 Mach-O sections, including 37 file-backed sections, between release and signed candidate; this does not claim whole-file byte equality. Live PID 98330 started at local 2026-10-12 06:06:35. Health reports AX and both OS permissions pass, independent bundle identity degraded as expected, and capture capability skipped in the readonly report. Stock and native7 rollback remain preserved.

Two initial real wrong-focus probes correctly refused input but produced no click journal entry. A fresh bounded raw-shape probe proved native and SDK retained the full structured diagnostic. The private logger omitted its non-null overlay identity helper; mock fixtures only covered null. This private observability defect was corrected with a strict PID/CGID projector, a real-shape structuredJson regression and malformed-overlay refusal. Sol independently ran all 4 journal tests successfully. Preload SHA256 is now `b1f67e10c36d28409492d8f755cfa685b2789ce644aec1029044436b4982d05f`; prior failed probes remain unchanged.

New UUID `7e5e46cf-a5e7-414e-aece-0c15c7e90886` produced a real wrong-focus refusal, zero Provider requests, and no cleanup errors. The SDK guard diagnostic exactly matches the private journal: target PID 98881/window 18045, actual foreground PID 98930, point test not evaluated. Root independently reran 4 tests and checked all journal fields. Private receipts: `sol-native8-live-journal-verification.json`, `root-native8-live-journal-independent-review.json`, `root-native8-binary-section-review.json`, and `root-native8-independent-replay.json`. This signs off diagnostic delivery only; it does not identify the old T3 refusal cause or accept T1/T2/T3 business results.
