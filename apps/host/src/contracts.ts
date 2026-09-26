/** Local Host pairing projections. Run DTOs live in app-runtime/remote-control. */

export interface PairRequestView {
  readonly requestId: string;
  readonly clientName: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: "pending_local_confirmation" | "approved" | "rejected" | "expired";
  readonly deviceId?: string;
}

export interface PairedDeviceView {
  readonly deviceId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}
