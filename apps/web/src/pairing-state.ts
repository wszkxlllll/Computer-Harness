import type { PairRequestStatus } from "./types";

export function shouldEstablishSession(status: PairRequestStatus["status"]): boolean {
  return status === "approved";
}
