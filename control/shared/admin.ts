import type { ImportDeployment, MailboxStatus } from './session-import';
export type AdminNodeState = 'ready' | 'connecting' | 'offline' | 'removed';
export interface AdminNodeMetrics {
  at: number;
  cpu: number;
  memory: { total: number; available: number };
  gpus: {
    name: string;
    engine3d: number;
    engineVideoEncode: number;
    dedicatedUsed: number;
    dedicatedTotal: number;
  }[];
  disk: { total: number; free: number };
  objectBytes: number;
}
export interface AdminNode {
  nodeId: string;
  state: AdminNodeState;
  managed: boolean;
  advertise: string;
  buildId: string | null;
  pressure: number | null;
  underPressure: boolean;
  diskDraining: boolean;
  sessions: number;
  maxSessions: number;
  users: string[];
  replicaBytes: number;
  metrics: AdminNodeMetrics | null;
  connectedAt: number | null;
  disconnectedAt: number | null;
  rejected: { code: string; buildId: string; at: number } | null;
  exited: { code: number | null; at: number } | null;
}
export type AdminSessionState =
  | { state: 'none' }
  | { state: 'active'; nodeId: string }
  | { state: 'hibernated'; checkpointAt: number | null };
export interface AdminUser {
  username: string;
  isAdmin: boolean;
  disabled: boolean;
  online: boolean;
  lastLoginAt: number | null;
  session: AdminSessionState;
  secondFactors: { pin: boolean; face: boolean };
  storage: { bytes: number; quotaBytes: number };
}
export interface AdminUserStorage {
  username: string;
  libraryFiles: number;
  objects: number;
  bytes: number;
  quotaBytes: number;
  checkpoints: number;
  latestCheckpointBytes: number;
  latestCheckpointAt: number | null;
}
export interface AdminStorage {
  objects: number;
  bytes: number;
  storedBytes: number;
  underReplicated: number;
  orphans: number;
  pendingSessionDeletions: number;
  users: AdminUserStorage[];
}
export interface AdminOverview {
  buildId: string;
  release: { buildId: string; size: number } | null;
  nodes: { total: number; ready: number; mismatched: number };
  users: { total: number; online: number; disabled: number };
  sessions: { active: number; hibernated: number };
  storage: { bytes: number; underReplicated: number; pendingSessionDeletions: number };
  diagnostics: number;
  sessionImport: MailboxStatus;
}
export interface AdminDiagnostic {
  id: string;
  username: string | null;
  createdAt: number;
  bytes: number;
  reason: string;
}
type User = { username: string };
export interface AdminSocketMethods {
  'admin.overview': { params: Record<string, never>; result: AdminOverview };
  'admin.users': { params: Record<string, never>; result: AdminUser[] };
  'admin.createUser': { params: User & { password: string }; result: AdminUser[] };
  'admin.resetPassword': { params: User & { password: string }; result: AdminUser[] };
  'admin.clearSecondFactors': { params: User; result: AdminUser[] };
  'admin.signOut': { params: User; result: AdminUser[] };
  'admin.setDisabled': { params: User & { disabled: boolean }; result: AdminUser[] };
  'admin.transferAdmin': { params: User; result: AdminUser[] };
  'admin.hibernate': { params: User; result: AdminUser[] };
  'admin.resetSession': { params: User; result: AdminUser[] };
  'admin.deleteUser': { params: User; result: AdminUser[] };
  'admin.storage': { params: Record<string, never>; result: AdminStorage };
  'admin.nodes': { params: Record<string, never>; result: AdminNode[] };
  'admin.removeNode': { params: { nodeId: string }; result: AdminNode[] };
  'admin.readdNode': { params: { nodeId: string }; result: AdminNode[] };
  'admin.diagnostics': { params: Record<string, never>; result: AdminDiagnostic[] };
  'admin.deleteDiagnostic': { params: { id: string }; result: AdminDiagnostic[] };
  'admin.sessionImportDeployment': { params: Record<string, never>; result: ImportDeployment };
  'admin.downloadDiagnostic': { params: { id: string }; result: { url: string } };
}
