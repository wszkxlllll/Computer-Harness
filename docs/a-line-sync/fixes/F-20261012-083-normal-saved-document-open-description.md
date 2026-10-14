# F-20261012-083 — Describe the normal application document-open route

The complete high-v4 T2 Run saved the exact 196-byte target and closed it, then autonomously selected the explicitly prepared recovery blank. Its next actual Provider context included `reopen_saved_document`, but the model treated that tool as different from the task's “normal application open” requirement and chose CMD+O. The resulting new Open window was outside the exact Run scope; no valid attached-sheet proof authorized it. A repeated shortcut and pixel click were refused, and the existing no-progress monitor normally cancelled the Run. No operator opened the document or rebound the Open panel.

## Change

Only the existing tool description is clarified: it invokes the application's normal macOS open-document handler (NSWorkspace/odoc) for the single Host-authorized saved file. The zero-argument schema, Run opt-in, clean saved-document proof, completed CMD+W plus fresh missing-window proof, fresh recovery observation and dispatch-time one-use consumption remain unchanged. Catalog visibility is not confused with permission to execute. This does not automatically select a tool, alter the task, weaken scope or fix general Open-panel admission.

## Evidence and limits

- Real Run `run-1791760881790-78afed3c-563`, sequence 145: the model explicitly considered the tool and chose CMD+O because it interpreted “normal application open” as the GUI shortcut route. Actual post-recovery Provider schemas contained the tool; it was not missing.
- The Run ended `cancelled` at sequence 175 after the exact owned monitor issued SIGINT for matching unchanged observations 163 and 172. It made 22 main requests, with 21 known responses totaling 274,861 tokens and one cancelled request without usage. All 22 actual configurations were high/enabled, 8,192 tokens, nonstreaming.
- The saved file remains exact UTF-8: 196 bytes, six LF characters, one trailing LF, SHA `58a4fcd47da3982ab890ad46febf0eecd7c3c8d52b19723d65092d43cac43beb`. Completed close sequence 129 and scoped recovery sequences 133/137/140 were recorded. Target reopen and final content verification were not completed, so full T2 is not accepted.
- Author reused existing contracts: Runtime reopen test 1/1 and CUA opt-in/single-file/reopen tests 17/17 passed; Runtime typecheck and build exited 0. No string-mirroring test was added for this wording change.
- Sol independently read the actual model decision, exposed schema, source dispatch route and description-only diff; loading the production dist confirmed the empty-object schema, ungranted-path rejection, isolated computer-action flag and original zero-parameter ActionIntent. Final source SHA `5448920bd171240430e29b1380e7a678c3cfb3a3f906dd78254b6d20fcd38293`; dist SHA `430c33fac71aab125884cac0902f8fca865359b232714c05ff5a320fec92ea91`. The clarification is a new test condition, not proof that the model will choose correctly or that complete business execution now passes.

The failed Run and its correct saved output are retained. A subsequent complete Run uses a new unique output path, unchanged 196-byte text and complete original task, with bounded budget and first-event supervision. Native code, signature, permissions and GUI action routing are unchanged.
