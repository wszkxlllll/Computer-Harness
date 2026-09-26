import { establishPairSession, getPairRequest, getPhoneSession, setPhoneCsrfToken, submitPairRequest } from "./api";

const requestPromises = new Map<string, ReturnType<typeof submitPairRequest>>();
const pairRequestPromises = new Map<string, ReturnType<typeof getPairRequest>>();
const pairSessionPromises = new Map<string, ReturnType<typeof establishPairSession>>();
const establishedPairRequests = new Set<string>();
let phoneSessionPromise: ReturnType<typeof getPhoneSession> | undefined;

export function submitTokenOnce(token: string) {
  const existing = requestPromises.get(token);
  if (existing) return existing;
  const pending = submitPairRequest(token, "手机浏览器").then((result) => {
    if (requestPromises.get(token) === pending) requestPromises.delete(token);
    return result;
  }).catch((error: unknown) => {
    if (requestPromises.get(token) === pending) requestPromises.delete(token);
    throw error;
  });
  requestPromises.set(token, pending);
  return pending;
}

export function getPairRequestOnce(requestId: string) {
  const existing = pairRequestPromises.get(requestId);
  if (existing) return existing;
  const pending = getPairRequest(requestId).finally(() => {
    if (pairRequestPromises.get(requestId) === pending) pairRequestPromises.delete(requestId);
  });
  pairRequestPromises.set(requestId, pending);
  return pending;
}

export function establishPairSessionOnce(requestId: string) {
  const existing = pairSessionPromises.get(requestId);
  if (existing) return existing;
  const pending = establishPairSession(requestId).then((session) => {
    setPhoneCsrfToken(session.csrfToken);
    establishedPairRequests.add(requestId);
    clearPairRequestReference(requestId);
    return session;
  }).finally(() => {
    if (pairSessionPromises.get(requestId) === pending) pairSessionPromises.delete(requestId);
  });
  pairSessionPromises.set(requestId, pending);
  return pending;
}

export function getPendingPairSession(requestId: string) {
  return pairSessionPromises.get(requestId);
}

export function hasEstablishedPairSession(requestId: string) {
  return establishedPairRequests.has(requestId);
}

export function getPhoneSessionOnce() {
  if (phoneSessionPromise) return phoneSessionPromise;
  const pending = getPhoneSession().finally(() => {
    if (phoneSessionPromise === pending) phoneSessionPromise = undefined;
  });
  phoneSessionPromise = pending;
  return pending;
}

export function readStoredRequestId(): string | undefined {
  const queryId = new URLSearchParams(window.location.search).get("request");
  if (queryId) return queryId;
  try {
    return window.sessionStorage.getItem("harness-pair-request") ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeRequestId(requestId: string) {
  try {
    window.sessionStorage.setItem("harness-pair-request", requestId);
  } catch {
    // The request ID is also kept in the URL for reload recovery.
  }
}

export function clearPairRequestReference(requestId: string) {
  try {
    if (window.sessionStorage.getItem("harness-pair-request") === requestId) {
      window.sessionStorage.removeItem("harness-pair-request");
    }
  } catch {
    // Session storage may be disabled; the URL reference is cleared when available.
  }

  const url = new URL(window.location.href);
  if (url.pathname !== "/pair") return;
  const currentRequestId = url.searchParams.get("request");
  if (currentRequestId && currentRequestId !== requestId) return;
  url.searchParams.delete("request");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
