# F-20261012-085: Authorized save observation evidence

## Evidence and scope

Two isolated scratch runs showed the UI's automatic-extension checkbox checked in both cases, while the saved paths differed: the no-extension run produced the 33-byte no-extension file, and explicitly entering `.txt` produced the corresponding `.txt` file. The independent receipt is `A06-private/sol-extension-auto-vs-explicit-independent-review.json`. These observations describe a UI-to-disk inference trap; they do not establish a native typing defect or a successful formal task.

The opt-in Host observation now carries `authorizedSavedDocumentEvidence` with a bounded source and status, bound to the exact Observation ID and Surface reference. It reports exact authorized-file absence only when the pinned parent remains stable and the file read is `ENOENT`; permission/other IO errors, parent changes, and native-proof failures remain `unverified`. A clean current document plus stable before/after file identity may report `verified_clean_current_document`. A recovery blank and Runs without the singleton Host grant omit the fact. The evidence contains no path, URL, body, or save instruction and attests to binding/presence only, not document bytes, line endings, or task success. It does not change the existing reopen grant or Guard conditions.

The runtime same-frame fingerprint compares only evidence source/status, not the per-capture Observation ID; the full evidence remains correlated to the exact Observation and Surface in the capture, trajectory, and Context projection. This keeps same-status frames stable while treating a status change as changed evidence.

## Verification

- Author CUA/runtime/context/trajectory focused set: 595/595 passed, exec session 31559; command: `pnpm exec vitest run packages/computer-cua/src/cua-driver-computer.test.ts packages/runtime/src/index.test.ts packages/context/src/index.test.ts packages/trajectory/src/index.test.ts`.
- After a test-only correction to make the parent-replacement fixture return a valid native proof before changing the pinned directory, the corrected case passed 1/1; exec output at 08:06:01. The four-file set was not rerun after this fixture-only adjustment.
- TypeScript project-reference check passed, exec session 82041; command: `pnpm exec tsc -b packages/protocol packages/trajectory packages/computer-cua packages/runtime packages/context --pretty false`.
- `git diff --check` passed for the nine source/test files.
- These are author offline tests/typecheck. No native build, GUI/SDK lifecycle run, Provider request, or paid run is claimed here.

## Independent verification after the author checks

Sol independently ran 20 CUA singleton/file-state cases (session 26328) and the real Runtime semantic-fingerprint case (session 71693), all passing. Root independently ran the two Context/trajectory consumption cases, both passing. The EACCES/EIO cases use an injected reader for the production classifier; they are not an operating-system permission experiment. The corrected parent fixture first proves the stable-parent absent state, then returns the same valid native proof while replacing the parent, which remains unverified.

Sol then ran one new, isolated production Runtime/Computer/SDK lifecycle with local fixture decisions and layered Guard, zero real Provider HTTP: `run-1791763650712-7605c90a-84e`. The actual compiled Provider messages contain absent before Save and verified after Save; recovery-blank and newly reopened-window messages omit the fact. Every persisted evidence value matches its Observation ID and Surface. The short 33-byte diagnostic file was saved, closed once, recovered, reopened through the singleton, freshly observed, and followed by an ordinary action and finish. Sixteen local fixture turns yielded thirteen completed Computer action receipts, no errors or cleanup error. Sol viewed the final real PNG and independently checked the diagnostic bytes. This is a limited lifecycle/evidence verification, not formal T2 acceptance.

Private receipts: `A07-private/sol-f085-frozen-source-independent-review.json`, `A07-private/sol-f085-build-and-live-pin-review.json`, and `A07-private/sol-authorized-evidence-live-f80b6e71-bbfd-416f-8222-3c5ebe466d38/sol-live-independent-review.json`. The native candidate was unchanged. Formal T2 baseline/repeat/variant remain incomplete; A07 has no paid requests yet.
