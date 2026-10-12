# F088 — preserve exact native document task text through Web

The new native document profile inherited generic goal trimming in GoalComposer and RemoteRunApi. Before the first formal Web Start, inspection showed that the frozen 1133-byte task would lose its two trailing line feeds. No Run or Provider request was started with the shortened text.

Only the opt-in `native-recovery` mode now preserves the original goal. Whitespace-only input remains invalid, the original string remains bounded to 20,000 characters, and idempotency compares the exact retained text. Existing modes retain their trimming behavior. Host and Relay already forward the string without trimming; their existing boundary tests now include Chinese text, leading spaces and two trailing line feeds.

The same focused correction fixes the new RemoteRunApi native-profile positive test fixtures: temporarily set Darwin with a saved process.platform descriptor and restore it in finally. A real factory non-Darwin refusal remains tested; production gates are unchanged. The previous 3001a1c CI failed on the same two fixtures on all three non-macOS jobs (2033 passed, two failed); its failure remains recorded.

Sol validation: Web, Host and Relay complete boundary suites 38/38; complete RemoteRunApi suite 66/66; tsc-b and Web production build exit 0. The author separately ran seven focused native-profile tests. No GUI task, model request, file save, or native binary change is represented by these tests. The full 1133-byte card and 196-byte expected body remain unchanged. The first normal Web pairing is retained as a pre-Run preparation record; new loaded processes, pairing, ready-before-Provider and final business results must be verified separately.
