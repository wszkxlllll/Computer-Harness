# N9 repairs integrated with main

The historical [N9 source snapshot](astra-n9-verified-2026-10-25.md) is tag [`astra-n9-verified-20261025`](https://github.com/wszkxlllll/Computer-Harness/tree/astra-n9-verified-20261025), commit `870ba59fdec2e627034a5aa63ff74301c2a4148f`. Its 468 runtime-source fingerprints match the real-tested candidate. Its paired macOS driver has a complete source patch chain, original attribution and a clean 443-file replay check.

This branch combines those repairs with main `f510b914b512a9496d5a988d0631286dc25e5200`. It is a new integration and does not inherit the historical live-test sign-off. The original development checkout, frozen source/build and running local application were not replaced.

## Main contracts retained

- DeepSeek/Ark and shared chat-completions remain; GLM ambiguity hints are restricted to the GLM boundary.
- Hard Run deadlines and the closing phase, provider HTTP reserves, Retry-After/429 handling, Monitor guidance and final-report contracts remain.
- Main's local multiline-input approval boundary remains; no global Guard bypass was introduced.
- A browser companion does not implicitly enable DOM/UIA; explicit configuration remains authoritative.
- Installer/doctor fixes, current reports and figures, script archives and CI remain.

## N9 repairs included

The integration includes typed native no-input/partial outcomes, scoped and attested macOS window inventories, exact-window geometry-race handling, Run-owned TextEdit transitions and explicit browser restoration; visibility metadata and refreshed explicit switches; opt-in one-use pre-header recovery and strict format-feedback recovery; fresh observation before repeated desktop Enter, Go-To or identical-click requests can send input; and Web start/stop controls.

Main already reserves two HTTP attempts, so that retry policy is retained. Explicit non-ambiguous format feedback gets the strict-comparison boundary needed for a fully reserved retry. Recovery also checks the hard Run clock after failure, observation and preparation; transport and 429 behavior are preserved.

Host defaults remain layered Guard with semantic risk review off. The new `--risk-model same` explicitly selects the N9 semantic-review configuration; use `--risk-max-model-requests 12 --risk-timeout-ms 60000` for its recorded limits. Historical N9 defaulted to `same`; this branch keeps current users' default costs unchanged. Low thinking is not promoted to a default.

## Verification

| Scope | Result |
| --- | --- |
| Exact N9 snapshot | TypeScript and Web build passed; 2,625 Vitest and 234 Node tests passed. |
| Native source closure | Twelve patches replayed from pinned upstream; all 443 final source files matched the historical driver source. No new native binary was built or shipped. |
| Integration typecheck and Web build | Passed with Node 24.18.0 and pinned pnpm 11.19.0. |
| Integration default test command | 143 Vitest files: 2,859 passed, one existing platform-specific skip; 306 Node tests passed with zero failures/skips. |
| Separate targeted reviews | CUA 497 cases and Runtime/Context/Provider 521 cases passed; they overlap the full suite and are not added to it. |

An initial snapshot HTTP test ran before Web build was ready and saw 404; build-before-test then passed without product changes. The first integration suite exposed one legacy receipt test assuming desktop companion mode implicitly enables DOM. Its expectation now follows main's explicit-authority behavior; whitelist/privacy/terminal assertions remain. The 94-case file and complete command subsequently passed. Original failures remain in private logs.

No fresh business Run, foreground GUI operation, physical-phone/public-Relay test or Windows/Linux native test was performed during publication. A48/A49/A50 results and strict deviations remain in the historical snapshot record. CI and merge readiness do not constitute deployment or real-task verification of this new combination.
