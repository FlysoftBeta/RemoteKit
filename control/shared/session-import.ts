export interface ImportCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'unspecified' | 'none' | 'lax' | 'strict';
  expires: number | null;
}
export interface ImportStorage {
  origin: string;
  items: [string, string][];
}
export interface ImportChunk {
  cookies: ImportCookie[];
  localStorage: ImportStorage[];
}
export interface BrowserMetadata {
  platform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  wow64: boolean;
  model: string;
  mobile: boolean;
  brands: { brand: string; version: string }[];
  fullVersionList: { brand: string; version: string }[];
}
export interface BrowserIdentity {
  userAgent: string;
  metadata: BrowserMetadata;
}
export interface ImportDeployment {
  v: 1;
  server: string;
  mailbox: string;
  key: { id: string; x25519: string };
  browser: BrowserMetadata & { userAgent: string };
}
export interface ImportSite {
  name: string;
  url: string;
}
export type DeviceEvent =
  | {
      seq: number;
      at: number;
      type: 'pair';
      username: string;
      password: string;
      code: string[];
      device: string;
    }
  | ({ seq: number; at: number; type: 'import'; id: string; sites: ImportSite[] } & ImportChunk)
  | { seq: number; at: number; type: 'withdraw'; id: string };
export interface ApplyCounts {
  applied: number;
  rejected: number;
}
export type ControlEvent =
  | { seq: number; at: number; type: 'paired'; ref: number; username: string }
  | { seq: 0; at: number; type: 'pairRejected'; ref: number; reason: string }
  | { seq: number; at: number; type: 'importReceived'; ref: number; id: string }
  | {
      seq: number;
      at: number;
      type: 'importApplied';
      ref: number;
      id: string;
      cookies: ApplyCounts;
      localStorage: ApplyCounts;
    }
  | {
      seq: number;
      at: number;
      type: 'importFailed';
      ref: number;
      id: string;
      reason: string;
      retryable: boolean;
    }
  | { seq: number; at: number; type: 'importDiscarded'; ref: number; id: string }
  | { seq: number; at: number; type: 'revoked' };
export interface ImportMessage<E> {
  v: 2;
  ack: number;
  events: E[];
}
export type ImportState = 'pending' | 'applied' | 'failed' | 'discarded';
export interface ImportRecord {
  id: string;
  sites: ImportSite[];
  state: ImportState;
  cookies: number;
  origins: number;
  rejectedItems: number;
  error: string | null;
  receivedAt: number;
  finishedAt: number | null;
}
export type PairingClosedReason = 'paired' | 'expired' | 'failures' | 'user';
export interface PairingState {
  open: boolean;
  code: string[] | null;
  expiresAt: number | null;
  failures: number;
  closedReason: PairingClosedReason | null;
}
export interface ImportDevice {
  keyId: string;
  name: string;
  pairedAt: number;
  lastRequestAt: number | null;
}
export type TimelineRequest =
  | { type: 'pair'; device: string }
  | { type: 'import'; id: string; sites: ImportSite[]; cookies: number; origins: number }
  | { type: 'withdraw'; id: string };
export interface TimelineEntry {
  keyId: string;
  device: string;
  paired: boolean;
  seq: number;
  at: number;
  receivedAt: number;
  request: TimelineRequest;
  record: ImportRecord | null;
  replies: ControlEvent[];
}
export interface SessionImportState {
  receiving: boolean;
  pairing: PairingState;
  devices: ImportDevice[];
  timeline: TimelineEntry[];
}
export interface MailboxStatus {
  configured: boolean;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  outbox: { pending: number; lastErrorAt: number | null; lastError: string | null };
}
export interface SessionImportSocketMethods {
  'sessionImport.state': { params: Record<string, never>; result: SessionImportState };
  'sessionImport.pairing': { params: { open: boolean }; result: PairingState };
  'sessionImport.removeDevice': { params: { keyId: string }; result: { ok: true } };
  'sessionImport.discard': { params: { id: string }; result: { ok: true } };
}
export interface StorageImportJob {
  accepted: true;
  job: string;
  browserIncarnation: string;
}
export type StorageImportStatus =
  | { state: 'pending' }
  | {
      state: 'done';
      cookies: { applied: number; rejected: number };
      localStorage: { applied: number; rejected: number };
    };
