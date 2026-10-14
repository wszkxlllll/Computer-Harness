import { parseSourceLinkedFinishContractJson } from "@computer-harness/app-runtime";
import type { SourceLinkedFinishContract } from "@computer-harness/protocol";

/** Host-wide explicit opt-in; omitted values preserve ordinary finish behavior. */
export function resolveHostSourceLinkedFinishContract(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SourceLinkedFinishContract | undefined {
  const raw = environment.HARNESS_SOURCE_LINKED_FINISH_CONTRACT;
  return raw === undefined ? undefined : parseSourceLinkedFinishContractJson(raw);
}
