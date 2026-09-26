const isPairingRoute = window.location.pathname === "/pair";
let initialPairingToken = isPairingRoute ? new URLSearchParams(window.location.search).get("token") ?? undefined : undefined;

if (isPairingRoute && initialPairingToken) {
  // Remove the one-use secret before rendering or making any API request.
  window.history.replaceState(null, "", "/pair");
}

export function getInitialPairingToken(): string | undefined {
  return initialPairingToken;
}

export function clearInitialPairingToken(): void {
  initialPairingToken = undefined;
}
