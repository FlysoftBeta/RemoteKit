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
  username: string;
  password: string;
  device: string;
  sites: ImportSite[];
}
export interface ImportSite {
  name: string;
  url: string;
}
export type StoredImportPayload = Omit<ImportPayload, 'username' | 'password'>;
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
export interface ImportRecord {
  id: string;
  sites: ImportSite[];
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
  receiving: boolean;
  imports: ImportRecord[];
}
export interface SessionImportSocketMethods {
  'sessionImport.state': { params: Record<string, never>; result: SessionImportState };
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
