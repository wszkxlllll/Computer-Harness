# Astra N9 verified source snapshot

This records the complete local Harness repair chain used by the N9 real-task tests. The immutable `astra-n9-verified-20261025` tag identifies the historical runtime source. The branch `codex/astra-n9-verified-20261025` subsequently combines those repairs with current main; that combination is a new version and does not inherit the historical live-test sign-off.

## Source and dependencies

- Original Harness base: `a2757d64a48245510a31905068569ea7e65f04bb`.
- Frozen local version: `astra-two-domain-format-feedback-v1`.
- Original freeze digest: `951f915d36f220b6391b97700069ed378933df65880c50484bf5043cfbd5891e`.
- [Public evidence and 468 runtime-source fingerprints](../evidence/astra-n9-verified-20261025.json). Administrative documents, machine configuration and prebuilt outputs are excluded from these runtime pins.
- Node 24.18.0 and pnpm 11.19.0 were used for the fresh publication checkout. Install the pinned lockfile, then run `pnpm run typecheck`, `pnpm --filter @computer-harness/web build`, and `pnpm test` in that order. The exact snapshot passed 2,625 Vitest cases and 234 Node cases; this is offline verification, separate from real-task results.
- [Native source recipe, license and patch chain](../../patches/cua-driver/n9/README.md). The macOS cases used SDK 0.22.2 with a downstream patched driver, not the stock daemon download. Clean replay of the 12 patches matches all 443 archived driver source files. No application or native binary is distributed here.

Keep third-party source attribution and the binding's own notices. A new machine still needs a local driver build, signing/permission setup and behavior validation; source publication does not transfer the original machine's macOS permissions or guarantee byte-identical binaries.

## Configuration used by the real tasks

Use privately supplied model credentials. Do not commit `.env`, machine configuration, browser profiles, TCC data, provider exchanges or raw desktop screenshots.

| Setting | Recorded value |
| --- | --- |
| Provider | Real `glm-5.3-flash` |
| Main requests / steps | 100 / 100 |
| Guard | `live-interactive`, layered, `riskModel=same` |
| Risk requests / timeout | 12 / 60,000 ms |
| GLM text / wire input cap | 16,384 / 32,768 |
| Operation guidance | `HARNESS_OPERATION_GUIDANCE=catalog-v1` |
| Opt-in pre-header recovery | `HARNESS_PROVIDER_RECOVERY=ambiguous-headers-once-v1` |
| Recovery run window | `HARNESS_PROVIDER_RECOVERY_RUN_WINDOW_MS=900000` |
| Thinking | `GLM_THINKING=high` for A48/A49; `low` for A50 only |
| Task route | Normal paired local Web client; one Start; real model and CUA |

The original launch also set `GLM_MAX_INPUT_TOKENS=16384` and `GLM_MAX_WIRE_INPUT_TOKENS=32768`. Host request limits were explicitly supplied using `--max-model-requests 100 --max-steps 100 --risk-max-model-requests 12 --risk-timeout-ms 60000`. Supply your own socket and output directory through the normal Host configuration. The public manifest contains task templates; replace the communication output-path placeholder with a new unused absolute path and send the planned update only after the actual question.

A48/A50 selected whole-desktop mode with application switching disabled, with TextEdit already foreground before Start. The model created its own new document during the Run. A49 selected the ordinary browser target `https://www.apple.com.cn/mac/compare/`, a temporary managed browser and application switching disabled. The local Web client is not evidence of physical-phone/public-Relay acceptance.

## Actual results and limits

| Case | Business result | Independent limits |
| --- | --- | --- |
| A48, communication, high | Original synthetic notices, one actual update, self-new plaintext report, save, close, exact-path reopen and full-text verification passed. 39 main / 1 risk. | One scroll contradicts the model's all-keyboard summary; some required standalone waits were skipped. |
| A49, shopping, high | Three public product records and the actual budget change from CNY 9,000 to 6,500 passed core verification. 34 main / 2 risk. | An earlier source URL was omitted, two field timestamps were off by 8.226 seconds, and extra fields were reported. Full strict report acceptance failed. |
| A50, communication, low | Same business workflow completed; all-keyboard and 1,305-byte UTF-8/LF file passed, including real close and exact-path full-text reopen. 39 main / 10 risk. | Standalone-wait compliance failed. Five stale repeated shortcuts/Enters were refused before input; one argument error was also refused. |

The three Runs ended naturally with released ownership. During execution the coordinator supplied only one planned normal-client response per Run; no native business input, manual window rebinding or extra correction was used. Preparing the starting application outside a Run is recorded separately.

A49 supplies live evidence for the explicit format-feedback admission fix: its first malformed response took 45.317 seconds, the old 120-second window would not admit a second 90-second reservation, and the corrected retry was admitted without executing either bad tool call. Strict parsing, bounded retries and no replay of uncertain GUI actions remain essential.

A50 took 13 minutes 31 seconds versus A48's 20 minutes 13 seconds, a single observed reduction of 33.126%. Both main and risk thinking changed, the generated body was shorter, decisions differed, and network/queue variance remains. Its ten risk calls were separate aligned allows, not ten user authorization requests. This is not a stable success-rate result, isolated causal benchmark or promotion of low thinking to a product default.

Outstanding items include exact field/source/time binding, strict refresh compliance, ordinary browser-to-native close recovery, the older calendar/draft test residuals, physical phones/public Relay and the full original acceptance matrix. These business passes do not close those items.
