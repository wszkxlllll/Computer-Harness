# DEV-2 TUI no-goal WinPTY UX validation

Status: completed on 2026-09-18 against the fixed candidate dist. All four
bounded cases passed. This is terminal UX evidence only; it is not model, CUA,
desktop, or provider evidence.

This validation is terminal-only. It uses the production CLI entry through a
real `pywinpty`/WinPTY child, with no `--goal`, no `--env-file`, no provider
credentials, no model request, no CUA daemon, no desktop window, and no
clipboard or private user text. The synthetic input is written only to the
ignored local transcript directory and is not part of this document.

## Scope

`spikes/cua-driver/dev2-tui-ux-pty-probe.py` runs four bounded fresh children:

* `rapid/esc-q`: one 544-character synthetic write, resize from 80 to 100
  columns, Escape back to the home key mode, then `q` exit;
* `slow/esc-q`: the same input in bounded 32-character chunks, then Escape/Q;
* `rapid/ctrl-c` and `slow/ctrl-c`: the corresponding two input modes, then
  Ctrl-C exit.

The Chinese paste is the synthetic marker `受控中文粘贴测试` (8 code points).
The over-limit input places `TAIL-END-9f1c` within the first 500 characters,
followed by synthetic overflow text. No private user text or emoji was used.

The probe records only booleans, sizes, lengths, exit status, cursor escape
markers, and safe counts. Raw terminal output and JSON metrics remain below an
ignored `runs/` directory. A forced child close is a failure, not a cleanup
success. The old `dev2-pty-probe.py` is not modified and its historical
assumptions are not reused.

## Reproduction (after final-build confirmation)

From the repository root, use the approved Node 24 runtime and an ASCII local
output directory. Replace `<repo>` and `<node24>` with local paths; do not add
`--env-file` or a goal:

```powershell
python spikes/cua-driver/dev2-tui-ux-pty-probe.py <repo> <node24> runs/dev2-tui-ux-pty
```

The command must be run only after the final dist build is declared. It does
not run the model because neither child receives a goal or a submit key.

## Results

Fixed build and runtime:

* Node `v24.19.0`.
* `apps/cli/dist/index.js` SHA-256
  `B1CC8BBE7AC70040BF3C824D44CBCED27A89B1513FEFCA225C4EF0659DDF1324`.
* `apps/cli/dist/tui.js` SHA-256
  `6D409F5E379D9C2773D5A545E59AD6DD37CB099B93495238B3554BC25F056717`.

| case | write return / input | input frames after paste | write time | tail + limit | exit / cursor | forced close |
| --- | ---: | ---: | ---: | --- | --- | --- |
| rapid/esc-q | 544 / 544 | 1 | 1010.7 ms | true / true | 0 / true | false |
| slow/esc-q | 544 / 544 | 17 | 2387.7 ms | true / true | 0 / true | false |
| rapid/ctrl-c | 544 / 544 | 1 | 1006.1 ms | true / true | 0 / true | false |
| slow/ctrl-c | 544 / 544 | 17 | 2389.9 ms | true / true | 0 / true | false |

All cases also reported a real WinPTY TTY, HOME without `--goal`, Chinese
marker visibility, 80-column then 100-column separators, visible `Artifacts
root:` footer frames, no interactive-terminal error, no visible model request,
and owned-child cleanup. The optional psutil sample was available; child CPU
deltas were 0.1562–0.2656 seconds. The
transcripts contained no credential names, `--env-file`, `--goal`, or private
key markers. Raw transcripts and metrics remain under ignored
`runs/dev2-tui-ux-pty-final-candidate/` and are not committed.

## Rapid-paste interpretation

Earlier pre-candidate runs were intentionally retained as intermediate
failures: a 536-character rapid write produced hundreds of redraws, did not
reach the overflow marker, and left ESC/Ctrl-C queued until the child had to be
forced closed. That evidence was consistent with per-key rendering and PTY
output backpressure, but did not prove Node keypress delivery by itself.

The candidate run kept the rapid case instead of replacing it with the slow
case. Its rapid PTY write took about one second, but the post-paste region had
one input frame, reached both the limit notice and tail marker, and exited
normally with cursor restoration. This is bounded evidence that the candidate
paint coalescing removed the observed rapid-paste failure in this environment;
it is not a general guarantee for every terminal or paste transport.

No model request, CUA daemon, desktop action, clipboard access, screenshot, or
`.env` load was performed by this validation.
