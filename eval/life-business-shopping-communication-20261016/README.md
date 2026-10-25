# Shopping and communication task suite (2026-10-16)

This is a standalone suite with six source-checked task goals. The runner supports offline preparation and explicitly authorized execution; real GUI acceptance is still pending.

Select it with `scripts/life-eval/start.mjs --suite life-business-shopping-communication-20261016 --task-id <S01|S02|S03|CM01|CM02|CM03> --variant <B00|P10|M01|PM11>`. The default suite remains the original nine-task `life-business-20261015`; its goals and historical records are unchanged. Packages and run directories are suite-specific and freeze the selected manifest, source and build. Prepare a new package after any source/build/configuration change; old packages are not reused. Preparation is offline, not authorization for desktop control.

This suite uses Ark Agent Plan `deepseek-v4.1-flash`, with batching off and Planning/Memory selected only by the variant. All six start from their explicit official `startUrl`. The first observation still uses the primary desktop, with opted-in window switching for the two WPS tasks; the runner does not silently preselect native windows or perform the task for the model.

The local ignored `.tools/life-eval.local.json` can set `arkApiKeyEnv` to `ARK_API_KEY` (default) or explicitly `HUOSHAN_API_KEY`. Only authorized live execution reads the selected entry from the frozen private env file and maps it to child `ARK_API_KEY`; no fallback or env-file rewrite. Preparation/dry-run never read credentials. Review and authorization gates remain unchanged.

All six tasks use only public pages and do not require account login. They do not authorize access to real orders, chats, calendars, or accounts, nor purchases, returns, message delivery, invitations, calendar edits, or calendar sharing. S03 and CM03 ask only for one new DOCX each. Source access was checked on 2026-10-16; dynamic prices and policy/version changes require rechecking before any future evaluation.

See [the manifest](./tasks.json), [task cards](../../docs/history/2026-10-20-product-docs/life-business-task-cards-2026-10-15.md), and [source preflight](../../docs/history/2026-10-20-product-docs/life-business-shopping-communication-preflight-2026-10-16.md).

For comparison setup and commands, see [evaluation instructions](../../docs/history/2026-10-20-release-convergence/life-business-evaluation-2026-10-15.md#新六题方舟对照准备2026-10-16接续). No real GUI or API run is implied by offline runner integration.
