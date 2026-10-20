# Common-site URL picker implementation

日期：2026-10-02

Web exposes the optional typed `BrowserSiteChoice` entries through `App.commonSiteChoices` → `HomeScreen` → `GoalComposer`. The default is an empty list, and no site catalog is bundled. When valid entries are supplied, the browser-target form shows a labeled native select; choosing an entry fills the existing start-URL input, which remains editable. Starting a Run still requires the existing explicit submit action.

The picker does not alter Goal, browser session mode, or profile selection. It adds no site-purpose or observed-page context and changes no Runtime, RemoteRunAPI, or protocol contract. Entries with an empty label or an invalid HTTP(S) URL are omitted.

Verification on configured Node 24.19.0: `apps/web/src/HomeScreen.test.tsx` and `apps/web/src/App.test.tsx` passed 18/18 tests; `pnpm --filter @computer-harness/web run typecheck` passed. Coverage includes empty and invalid catalogs, URL selection/editing, explicit submission, unchanged temporary/saved session modes, disabled states, and App prop forwarding. These are local UI/mock checks and do not exercise a real browser, API, VM, or desktop.

Independent review (GPT-6.1 Sol medium) found no blocking issue in the injection and submission path. The reviewer independently ran the same 18 tests, checked the pilot runner syntax, and verified two Shanghai-timezone midnight date cases. The web typecheck result above remains the implementation author's verification, not a second reviewer run.

The retest runner now records the launch date in the manifest's Shanghai timezone separately from its historical manifest date; explicit travel dates and prior results are unchanged. New attempts use separate output suffixes and refuse non-empty output directories. Six prior incomplete tasks (SG01, SG02, SG03, SG05, ST01, ST03) are authorized for sequential live retesting with 100 actions / 100 model requests, Guard off and Monitor shadow. Outcomes belong in the existing Shanghai pilot record; these runs do not verify the phone picker or public deployment. This interface has not been deployed, and a production site catalog has not been supplied.
