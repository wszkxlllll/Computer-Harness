import type { RuntimeEvent } from "@computer-harness/protocol";

/** Read-only notification emitted after an event is appended and reduced. */
export type CommittedEventListener = (event: RuntimeEvent) => void;
