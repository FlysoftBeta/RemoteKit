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
export interface ImportPayload extends ImportChunk {
  v: 1;
  id: string;
  createdAt: number;
  token: string;
  device: string;
  site: { name: string; url: string };
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
export interface ImportPairing {
  v: 1;
  server: string;
  user: string;
  mailbox: string;
  key: { id: string; x25519: string };
  token: string;
  browser: BrowserMetadata & { userAgent: string };
}
export interface ImportRecord {
  id: string;
  siteName: string;
  siteUrl: string;
  device: string;
  createdAt: number;
  receivedAt: number;
  state: 'pending' | 'applied' | 'rejected' | 'failed';
  cookies: number;
  origins: number;
  rejectedItems: number;
  error: string | null;
  finishedAt: number | null;
}
export interface MailboxStatus {
  configured: boolean;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
}
export interface SessionImportState {
  mailbox: MailboxStatus;
  pairing: { createdAt: number } | null;
  imports: ImportRecord[];
}
export interface SessionImportSocketMethods {
  'sessionImport.state': { params: Record<string, never>; result: SessionImportState };
  'sessionImport.pair': { params: Record<string, never>; result: { code: string; createdAt: number } };
  'sessionImport.unpair': { params: Record<string, never>; result: { ok: true } };
  'sessionImport.delete': { params: { id: string }; result: { ok: true } };
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
