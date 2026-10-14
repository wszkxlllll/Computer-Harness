# F009 author freeze manifest

Date: 2026-10-07 (Asia/Shanghai). Scope: new read-only evidence asset only.

| File | SHA-256 |
| --- | --- |
| readonly-evidence-client.mjs | 30e41650fa745f57652642525331dc97e6f28e340bccb8429bffbe57d3af07b6 |
| readonly-evidence-client.test.mjs | 08aab6748c776271d687abcb4fcd3fa8042ad2618443f2f81ef17d557e5d3952 |
| README.md | 0caecd48baa0b8a6fbef0c52b322b39092a29b32ed4e9e89c4419ba4945c3c7e |
| independent.test.mjs (archived relative import) | d7950b9a8a376ccec49bf23b70287d56f9a522c8aa1e9aa01fd9d03e8e4dbc78 |

Author syntax checks for both modules exited 0. Author fixture tests passed
34/34 (14 top-level tests including 20 subtests), 54.130541 ms in the final
pre-freeze run. Earlier green reruns are not added to this count.

All tests inject filesystem/net/clock fixtures; no real socket server or client
was opened. No SDK, native binary, daemon, GUI, capture, input, provider/model
request, TERM, shutdown, file removal, TCC change, build or Git operation was
executed. Only the files in this new directory were written. F005/F006/F008,
business code/dist and fixed native source were not edited.

The first independent review found a repeated-connect fixture could send a
request twice before receiving its reply. A per-request sent latch was added
before the write, with an author regression. The earlier 32 green tests did not
cover this branch and do not override that failed counterexample. Independent
review subsequently found two additional failed counterexamples: invalid
metadata still allowed the second query, and a success envelope with an error
field was accepted. Metadata is now validated before that query, and both
success envelopes reject error/exit_code fields; an author regression covers
these conditions. The previous green 43 tests did not cover those conditions.
The third frozen version passed independent author34+independent12 tests,
46/46 (53.103125 ms), with three syntax checks exiting 0 and unchanged
pre/post hashes. These are the independent reviewer's actual reported fixture
results, not a second author run or a live test. No remaining P0/P1 applies
only to this offline scope. Matching positive self-reports
still return ownership unverified and dispatch false; this is not live
deployment, process ownership evidence, permission acceptance, or I002 closure.

The unique asset writer archived the independent test from its private review
directory after review. Original SHA-256 was
`eafb9e0a78463145bf78efcd5ef3cc3104c7de1bed609a942c8a97d871423fc3`.
Only its absolute import was replaced with `./readonly-evidence-client.mjs`;
the archived hash is in the table. Migration verification at the durable
paths is pending and does not add previous green reruns to the final count.
