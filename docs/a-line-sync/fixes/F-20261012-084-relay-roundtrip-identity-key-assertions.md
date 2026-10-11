# F084: Relay roundtrip checks private identity keys structurally

The cf4e54b CI run 38184685919 failed one Host roundtrip assertion on Ubuntu/Node 24: a random opaque candidate token contained `pID`, so scanning the entire serialized JSON incorrectly reported a private PID leak. The response contained no private identity keys. The preview assertion had the same defect for token/base64 values.

Only `apps/host/src/relay-roundtrip.test.ts` changes. Its recursive check rejects actual `pid`, `windowId`, and `socketPath` keys in objects and arrays, case-insensitively; values are not interpreted as keys. A deterministic opaque value containing all three names must pass, while each private nested key has an independent positive rejection assertion. Both existing window-choice and preview isolation checks remain. Production Host, Relay, protocol, native code, and Guard are unchanged.

Author Luna ran `pnpm exec vitest run apps/host/src/relay-roundtrip.test.ts`: 2/2 passed, and selected diff-check passed. Root independently ran the same file at final source SHA `34d9bb102d637ff73109cc14e2c3e2ad6c1860ed246fc4bf6ab30e502c1a23fe`: 2/2 passed, exit 0 (session 41383), selected diff-check 0. Sol read the complete diff and the three independent key cases. No real Provider request, desktop interaction, build, or service change was required for this fix.

The old cf4e54b failure remains historical evidence. New-head CI must be read independently after this test-only commit; these checks do not establish T2 business success.
