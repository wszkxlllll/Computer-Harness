import type { JsonObject, RelayHttpMethod } from "./routing.js";
import type { RemoteRunApi } from "@computer-harness/app-runtime";

export const RELAY_PROTOCOL_VERSION = 1;

export interface PairingTokenRegistration {
  pairingId: string;
  tokenHash: string;
  expiresAt: number;
}

export interface RelayBridgeRequest {
  type: "bridge.request";
  requestId: string;
  deviceId?: string;
  sessionToken?: string;
  method: RelayHttpMethod;
  /** Normalized allowlisted API path, with an optional validated query string. */
  path: string;
  csrfToken?: string;
  body?: JsonObject;
}

export interface RelayBridgeResponse {
  type: "bridge.response";
  requestId: string;
  statusCode: number;
  contentType: "application/json; charset=utf-8" | "text/plain; charset=utf-8" | string;
  /** UTF-8 serialized JSON/text response. */
  body?: string;
  /** Base64 encoded asset bytes. Only valid for the asset route. */
  bodyBase64?: string;
}

export interface RelayBridgeSubscribe {
  type: "bridge.subscribe";
  subscriptionId: string;
  deviceId: string;
  sessionToken: string;
  runId: string;
  afterSequence: number;
}

export interface RelayBridgeUnsubscribe {
  type: "bridge.unsubscribe";
  subscriptionId: string;
}

export type RelayBridgeEvent =
  | {
      type: "bridge.event";
      subscriptionId: string;
      runId: string;
      sequence: number;
      event: JsonObject;
    }
  | {
      type: "bridge.event";
      subscriptionId: string;
      runId: string;
      control: "resync_required";
      event: JsonObject;
    };

export interface HostHello {
  type: "host.hello";
  protocolVersion: number;
  hostId: string;
  credential: string;
}

export interface RelayReady {
  type: "relay.ready";
  protocolVersion: number;
  hostId: string;
}

export interface RelayPairingConsumed {
  type: "relay.pairing.consumed";
  pairingId: string;
}

export interface RelayPairingRegistered {
  type: "relay.pairing.registered";
  pairingId: string;
  expiresAt: number;
}

export interface RelaySessionRevoked {
  type: "relay.session.revoked";
  deviceId: string;
  sessionTokenHash?: string;
  revokedCount: number;
}

export interface HostPairingRegister {
  type: "host.pairing.register";
  pairingId: string;
  tokenHash: string;
  expiresAt: number;
}

export interface HostSessionRevoke {
  type: "host.session.revoke";
  deviceId: string;
  sessionTokenHash?: string;
}

export interface HostPairingUnregister {
  type: "host.pairing.unregister";
  pairingId: string;
}

export interface RelayProtocolError {
  type: "relay.error";
  code: "UNAUTHORIZED" | "INVALID_MESSAGE" | "HOST_BUSY" | "UNAVAILABLE";
}

export type HostToRelayMessage =
  | HostHello
  | HostPairingRegister
  | HostPairingUnregister
  | HostSessionRevoke
  | RelayBridgeResponse
  | RelayBridgeEvent;

export type RelayToHostMessage =
  | RelayReady
  | RelayPairingConsumed
  | RelayPairingRegistered
  | RelaySessionRevoked
  | RelayProtocolError
  | RelayBridgeRequest
  | RelayBridgeSubscribe
  | RelayBridgeUnsubscribe;

export interface HostRequestHandler {
  readonly api: RemoteRunApi;
  request(request: RelayBridgeRequest): Promise<HostApiResponse>;
  authorizeSession(deviceId: string, sessionToken: string): boolean;
}

export interface HostApiResponse {
  statusCode: number;
  contentType?: string;
  body?: unknown;
  bytes?: Uint8Array;
}

export function encodeWireMessage(message: HostToRelayMessage | RelayToHostMessage): string {
  return JSON.stringify(message);
}
