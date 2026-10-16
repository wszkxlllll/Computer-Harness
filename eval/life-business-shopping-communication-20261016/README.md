# Shopping and communication task suite (2026-10-16)

This is a standalone candidate suite with six source-checked task goals. Its status is `source_verified_pending_gui_and_runner_integration`.

It is deliberately not wired to `scripts/life-eval`, whose current runner pins `life-business-20261015` and its nine-task manifest. The existing nine-task manifest, prepared packages, historical eight-task run, and runner task selection remain unchanged. The current runner pins a manifest and source/build fingerprint: if a future integration changes that fingerprint, prepare a new package through the approved workflow rather than reusing any existing frozen package. Do not extend the old run or treat this candidate manifest as authorization for live activity.

All six tasks use only public pages and do not require account login. They do not authorize access to real orders, chats, calendars, or accounts, nor purchases, returns, message delivery, invitations, calendar edits, or calendar sharing. S03 and CM03 ask only for one new DOCX each. Source access was checked on 2026-10-16; dynamic prices and policy/version changes require rechecking before any future evaluation.

See [the manifest](tasks.json), [task cards](../../docs/life-business-task-cards-2026-10-15.md), and [source preflight](../../docs/life-business-shopping-communication-preflight-2026-10-16.md).
