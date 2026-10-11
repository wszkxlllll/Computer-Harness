# F-20261012-082 — Bounded pop for a hidden attached sheet

Status: source, corrected real-shape fixture and the zero-Provider scratch Save reconciliation are independently verified. Complete T2 save/close/reopen acceptance remains pending.

The high T2 Run had a completed Save click, followed by a fresh exact parent AX proof with no attached sheet and the parent focused. WindowServer still listed the previously admitted Save CGID, explicitly offscreen. The adapter treated that row as conflicting with the no-sheet proof and stopped reconciliation. This does not establish why the Save window became hidden; no click was replayed and no document was manually closed or reopened.

## Change

For the existing Darwin foreground attached-sheet path only, an exact admitted child row that remains explicitly offscreen may receive one 80 ms read-only recheck. The adapter requires fresh inventory, exact parent discovery and a second local AX proof showing no sheet and exact parent focus. It also rechecks parent/child geometry, stack generations, bindings, unique child identity and abort state immediately before the pop. Missing owner/minimized metadata is tolerated where macOS does not provide it; explicit contradictory owner data, duplicate rows, unknown visibility, a visible/replacement sheet, changing geometry or stack, read failure and abort refuse to pop. This proves the interaction surface is no longer attached; it does not claim the OS window object was destroyed.

The existing local-AX-none plus absent-child path is unchanged. No global inventory completeness requirement, same-PID/title inference, action replay, native changes or public protocol changes were added.

## Validation

- Author focused Vitest: hidden-child positive plus ten refusal scenarios, 11/11 passed in session 81419. The positive fixture now checks the emitted final inventory row directly: `is_on_screen: false`, with no `owner_pid`, `owner_window_id`, or `is_minimized` fields.
- Author full `cua-driver-computer.test.ts`: 333/333 passed in session 89758.
- Author `tsc --noEmit -p packages/computer-cua/tsconfig.json`: exit 0 in session 63085.
- Root independently executed the corrected focused suite: 11/11 passed, session 82149, 322 skipped. The first focused review passed but its no-owner claim was withdrawn after finding that the fake driver supplied owner metadata by default; the corrected fixture asserts the actual emitted inventory shape.
- Sol independently typechecked and built the package (both exit 0). Frozen source SHA `8ce081c689e2e6d7b5b44b46bdda15a1c1afc7fd328c2f7de5c227123ee6ebe7`; corrected test SHA `4a37873e2602cadbff0d7ac748c2b063ac5be30439615dcf18fdd47478512f32`; loaded dist SHA `0c83ced5c034838d49af3ec133a5df89297842c10367704af8901a48c10ec4e2`.
- Sol live scratch Run `run-1791760483385-9ce97acf-d5d`: succeeded, errors/cleanup errors absent, ten real GUI actions with one Save click, zero real Provider HTTP requests. Save CGID 18226 remained uniquely offscreen in both fresh inventories, with no owner/minimized fields. Parent 18219 had two complete local AX-none proofs, snapshots `s00000095` and `s00000096`, exact focus and unchanged geometry; the 80 ms read-only retry was actually exercised and the child popped once at sequence 99.
- The diagnostic file is exactly 33 UTF-8 bytes, SHA `244236b3958d4ce5c602b5db4e116fd5354cebc204f70d1e736b1eebb3a92674`. The fixture ended after fresh parent observation; it did not close/reopen and is not full business acceptance. The old formal saved file and failed Run remain intact.
- Private evidence: `A06-private/sol-singleton-live-ed68ae03-45f4-4693-bfba-4829677018b4/independent-proof.json` (SHA `c2a086c4bfe3bd9d7c35673c1350e66a58abe44b4a29644529496f2567f1ac2d`) and `A06-private/sol-f082-real-hidden-sheet-independent-review.json` under the existing autonomous batch root.
