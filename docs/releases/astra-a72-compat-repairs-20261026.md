# A72 compatibility repairs after the frozen A71 Demo — 2026-10-26

A71 remains frozen at local tag `astra-a71-interactive-demo-20261026`, commit `d0298c0b63e43a2b03094dfef0b6062de6f21397`. These follow-up repairs are a separate candidate; they do not inherit the A71 live Run outcome.

## Fixed behavior

1. Optional document guidance now combines common principles with instructions selected only from the opened Computer session platform. Windows instructions contain no Cmd/TextEdit guidance; unknown platforms receive only common principles. `catalog-v1` remains an explicit opt-in.
2. In opted-in Windows foreground native-window Runs, a fresh explicit current-window selection can restore the exact bound window, including an already-authorized peer. Before and after activation/capture, the adapter checks exact identity, geometry and physical foreground. Stale refs, scope exclusions, late focus loss, unknown outcomes and cancellation remain refused; normal input does not repeatedly activate windows.
3. The Mac hybrid recovery blank is excluded from ordinary window candidates and ordinary switch dispatch. The authorized saved-document close/handoff/reopen path remains available. This restriction is checked again even for a forged otherwise-fresh reference.
4. Mac desktop repeated Enter, same-point click and CMD+SHIFT+G no longer incur an extra blocking capture when the latest decision provides a correctly bound expected-change assessment. Missing, stale, negative, uncertain or wrong-action assessments and pixel changes alone cannot release an unresolved repeat. Windows receives no new repeat gate.

The existing five-second optional UIA/DOM read deadline now has Win32 and Mac timing/cancellation coverage; its default product value is unchanged. Existing unknown-action replay protection survives multiple current-window refocus generations.

## Validation

Fresh TypeScript and CUA spike typecheck, Web production build and complete offline suite passed: 143 Vitest files, 3008 tests passed and one pre-existing skipped test; 306 Node tests passed. Independent review passed for the final eight changed program/test files; its selected tests overlap the full suite and are not extra coverage totals. Counterfactual tests reproduced the frozen version defects before the fixes.

All execution in this repair round was offline on macOS, including Win32 simulation. There was no live model request, desktop action, Host restart, Native change, remote push or PR. The current Demo continues to use the original A71 environment. This candidate still needs separate Mac live validation and the appropriate Windows platform validation before claiming end-to-end compatibility.

The original shopping report's SSD inconsistency and other A71 acceptance limits remain historical evidence; this repair does not rewrite its content or certify full shopping accuracy. See the [A71 freeze](astra-a71-interactive-demo-20261026.md) for that boundary.
