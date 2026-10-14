# Opt-in authorized saved-document observation evidence

## Actual failure and bounded diagnosis

Formal T2 high-v5 `run-1791761681216-a295fdff-1f7` ended cancelled at seq154: 20 main requests, 19 known usage responses (236539 tokens), one unknown. Exact requested `.txt` path is absent. A no-extension file with the same basename contains the exact 196-byte body (SHA58a4..., six LF, one terminal LF). The model removed `.txt` at seq78, relied at seq86 on the visibly checked automatic-extension checkbox, saved once, and closed. The first `reopen_saved_document` call was refused before dispatch with DOCUMENT_REOPEN_NOT_READY. Existing observe code could not pin an absent exact Host-authorized file; that guard must remain strict.

Sol independently ran two finite new-scratch production Runtime/Computer/SDK diagnostics with local fixture decisions, layered Guard, zero real Provider HTTP. Neither touches the formal file. No-extension typing produced a no-extension 33-byte file; explicit `.txt` typing produced the exact `.txt` file. Both pre-Save PNGs show the checked automatic-extension checkbox. Fresh exact native document_identity_query proves each resulting AXDocument URL and typed clean close-button state. This supports an actual UI-to-disk inference trap, not a native typing or reopen-guard defect. Private index: `A06-private/sol-extension-auto-vs-explicit-independent-review.json`.

## Narrow implementation contract

Add one optional, independently sourced Observation fact for the existing Host singleton saved-file opt-in. Default Runs omit it. It is not an AX element, a model assessment, or a new execution permission. Use a strict source enum and three statuses: `authorized_file_absent`, `verified_clean_current_document`, and `unverified`. It exposes no path, URL, file contents, raw error, or save instruction.

Reuse initial-primary observe's existing parent/file/native document reads. Only an exact authorized-file lstat ENOENT, with the canonical parent identity still verified, can produce absent. Permission, other IO, invalid shape, changed parent, or native proof failure remains unverified. Verified requires the captured exact window's native clean document, same pinned application identity and expected URL, plus stable file identity. It does not establish disk-body bytes, UTF-8, LF, or overall task success. A present file while observing a recovery blank is not a failed save; report unverified or omit this fact there.

Preserve all original savedDocument, close receipt, missing-window, recoveryReady, one-shot dispatch, unknown-outcome and Guard conditions. Do not automatically rename/overwrite/close/reopen, append LF, or advise a particular Save sequence. The model receives only the read-only current evidence and chooses its own task actions.

## Necessary verification

Strict protocol and trajectory persistence/replay must reject unsupported status/source/shapes; runtime must preserve the adapter-produced fact, not accept model free text. Context must project it only with the corresponding current Observation and explicit host provenance, state that document binding is not content verification, and omit it for default Runs. Cover absent-vs-EACCES/other IO/parent change, verified current saved document, recovery blank, no-grant omission, persistence roundtrip and actual compiled Provider messages. Reuse existing singleton negative tests; no native rebuild or paid Run is needed for implementation checks. Then one independent zero-HTTP real lifecycle verifies the evidence chain before any new bounded paid batch.

Root reviewed these boundaries and supports this limited scope. Full T2 baseline/repeat/variant and T1/T3 remain incomplete; this is a new evidence variable, not a claimed business fix.
